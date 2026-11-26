import type { EventActor } from "@octant/contracts";
import {
  isAgentGrantSession,
  principalActsAsHostPerson,
  principalAuthorityKind,
  principalIsHubIntroduced,
  type ClientPrincipal,
} from "./clientPrincipal";
import { hubActRefusal, type HubActScopePort } from "./hub/hubActScope";
import { eventActorForPrincipal } from "./principalEventActor";
import { boundPrincipalIsRestricted } from "./principalRouteContext";
import {
  MAX_PAIRED_BROWSER_FILE_BYTES,
  decodePairedBrowserChooserId,
  decodePairedBrowserLeaseId,
  decodePairedBrowserRequest,
  decodePairedBrowserResponse,
  decodePairedBrowserStreamRequest,
  type PairedBrowserResponse,
} from "@octant/contracts/paired-browser-control";
import type {
  PairedBrowserActor,
  PairedBrowserControlService,
} from "./browser/pairedBrowserControl";
import {
  decodeBrowserDownloadPermissionsCommand,
  decodeBrowserDownloadPermissionsResult,
} from "@octant/contracts/browser-download-permissions";
import type { BrowserDownloadPermissions } from "./browser/browserDownloadPermissions";
import {
  decodeBrowserUploadPermissionsCommand,
  decodeBrowserUploadPermissionsResult,
} from "@octant/contracts/browser-upload-permissions";
import type { BrowserUploadPermissions } from "./browser/browserUploadPermissions";
import { browserProfileFromChoice } from "@octant/domain";
import type { BrowserAgentAvailability } from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { sameToolActionAuthority, type ToolActionAuthority } from "@octant/contracts";
import {
  decodeBrowserTaskProfileReadCommand,
  decodeBrowserTaskProfileSelectCommand,
  decodeBrowserTaskProfileState,
  decodeBrowserTaskProfileSelection,
  type BrowserTaskProfileState,
  type BrowserTaskProfileSelectCommand,
  decodeBrowserActionCommand,
  decodeBrowserAutomationSnapshot,
  decodeBrowserContextCancelCommand,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadScope,
  decodeBrowserThreadContextCommand,
  decodeBrowserThreadInspectCommand,
  decodeBrowserThreadScopeRequest,
  decodeBrowserToolApprovalDecision,
  type BrowserToolApproval,
  type BrowserToolApprovalDecision,
} from "@octant/contracts/browser-automation-rpc";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import {
  decodeBrowserAutomationFailure,
  type BrowserAutomationFailure,
  type BrowserThreadId,
} from "@octant/contracts/browser-automation";
import { decodeBrowserPageOfferCommand } from "@octant/contracts/browser-page-sessions";
import {
  decodeBrowserCaptureImage,
  decodeBrowserCaptureImageCommand,
  decodeBrowserCaptureTakeCommand,
  decodeBrowserCapturesCommand,
  decodeBrowserCapturesResponse,
  decodeBrowserStepsCommand,
  decodeBrowserStepsResponse,
} from "@octant/contracts/browser-capture";
import type {
  BrowserAuthorityResolver,
  BrowserAutomationService,
  BrowserTaskProfileCommit,
} from "./browser/browserAutomationService";
import type { BrowserCaptureService } from "./browser/browserCaptureService";
import type { BrowserPageOffers } from "./browser/browserPageOffers";
import { remoteBrowserActionReach } from "@octant/domain";
import {
  decodeProjectAgentPages,
  decodeProjectAgentPagesCommand,
  decodeProjectBrowserCommand,
  decodeProjectBrowserResult,
} from "@octant/contracts/project-browser";
import type { ProjectBrowserService } from "./browser/projectBrowserService";
import type { BrowserProfileService } from "./browser/browserProfileService";
import type { BrowserExtensionService } from "./browser/browserExtensionService";
import type { BrowserFlowService } from "./browser/browserFlows";
import type { BrowserFlowRuns } from "./browser/browserFlowRuns";
import {
  decodeBrowserFlowsCommand,
  decodeBrowserFlowsResult,
} from "@octant/contracts/browser-flows";
import {
  decodeBrowserExtensionsCommand,
  decodeBrowserExtensionsResult,
} from "@octant/contracts/browser-extensions";
import {
  decodeBrowserProfilesCommand,
  decodeBrowserProfilesResult,
} from "@octant/contracts/browser-profiles";
import { storedBrowserProfile } from "@octant/domain";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import {
  decodeBrowserCredentialCommand,
  decodeBrowserCredentialResult,
} from "@octant/contracts/browser-credential-use";
import type { BrowserCredentialUseService } from "./browser/browserCredentialUseService";
import type { WindowId } from "@octant/contracts/shell";
import type { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  decodeBrowserSessionGrantsCommand,
  decodeBrowserSessionGrantsResult,
} from "@octant/contracts/browser-session-grants";
import type { BrowserSessionGrants } from "./browser/browserSessionGrants";

const PREFIX = "/api/browser/";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BROWSER_MODES = ["chat", "work", "code"] as const;

export interface BrowserAutomationRouteDependencies {
  readonly downloadPermissions?: Pick<BrowserDownloadPermissions, "execute">;
  readonly uploadPermissions?: Pick<BrowserUploadPermissions, "execute">;
  readonly sessionGrants?: Pick<BrowserSessionGrants, "execute">;
  readonly agentAvailability?: (
    windowId: WindowId,
    threadId: BrowserThreadId,
  ) => BrowserAgentAvailability;
  readonly credentialUse?: Pick<BrowserCredentialUseService, "execute">;
  readonly service: Pick<
    BrowserAutomationService,
    "create" | "act" | "cancel" | "stop" | "inspect" | "inspectThread" | "releaseThread"
  > &
    Partial<Pick<BrowserAutomationService, "takeOver" | "handBack" | "switchTaskProfile">> &
    Partial<
      Pick<
        BrowserAutomationService,
        "peekThread" | "peekContext" | "profileOf" | "listProjectAgentPages"
      >
    >;
  /**
   * What the Project's tab strip needs beyond the Browser itself: whether the
   * window can open the Project, and the title of a thread it can see. Absent
   * on a host that has no Project threads to name.
   */
  readonly projectAgentPages?: {
    readonly windowCanOpenProject: (windowId: WindowId, projectId: string) => Promise<boolean>;
    readonly threadTitle: (threadId: BrowserThreadId, mode: "work" | "code") => string | undefined;
  };
  /** The page a restart took, offered back; absent on a host that records none. */
  readonly pageOffers?: Pick<
    BrowserPageOffers,
    "read" | "claim" | "dismiss" | "release" | "holdForOpen"
  >;
  /** The thread's kept screenshots; absent on a host that keeps none. */
  readonly captures?: Pick<BrowserCaptureService, "list" | "read" | "listSteps">;
  /**
   * Whether this window can open the thread, archived or not. Reading what a
   * thread kept asks this rather than live Browser authority, which an archived
   * thread, an archived Project, and a switched-off provider all lose. Absent
   * means nobody can read captures.
   */
  readonly windowCanOpenThread?: (
    windowId: WindowId,
    threadId: BrowserThreadId,
    principal: ClientPrincipal,
  ) => Promise<boolean>;
  readonly taskProfiles?: {
    read(
      threadId: BrowserThreadId,
      mode: "work" | "code",
    ):
      | {
          readonly version: BrowserTaskProfileState["version"];
          readonly profile: BrowserTaskProfileState["profile"];
          readonly modelId: string;
        }
      | undefined;
    save(
      windowId: WindowId,
      command: BrowserTaskProfileSelectCommand,
      commit: (persist: () => void) => boolean,
    ): Promise<BrowserTaskProfileCommit>;
    bind(contextId: string, modelId: string, authority: ToolActionAuthority): void;
  };
  readonly authority: BrowserAuthorityResolver;
  readonly approvals?: {
    list(windowId: WindowId): ReadonlyArray<BrowserToolApproval>;
    decide(windowId: WindowId, decision: BrowserToolApprovalDecision): boolean;
  };
  /** Browsers a Work or Code Project owns without a thread; absent on a host without them. */
  readonly projectBrowsers?: Pick<ProjectBrowserService, "execute">;
  /** Browser extensions, installed and enabled by the person; absent on a host without them. */
  readonly extensions?: Pick<BrowserExtensionService, "execute">;
  /** The stored Browser profiles (Project and Personal); absent on a host without them. */
  readonly profiles?: Pick<BrowserProfileService, "execute">;
  /** The Projects' saved Browser flows, listed and deleted by the person; absent on a host without them. */
  readonly flows?: Pick<BrowserFlowService, "summaries" | "delete">;
  readonly flowRuns?: BrowserFlowRuns;
  readonly pairedBrowserControl?: PairedBrowserControlService;
  readonly resolvePairedDeviceName?: (deviceId: string) => string | undefined;
  readonly isPairedDeviceSessionCurrent?: (
    principal: Extract<ClientPrincipal, { readonly kind: "remote-device" }>,
    sessionNow?: () => number,
  ) => boolean;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize: number;
  /** The member's Act item for its hub, which bounds where a device only the hub introduced may answer. */
  readonly hubActScope?: () => HubActScopePort | undefined;
  /** The Project of a Code or Work thread; undefined for a thread this host does not hold. */
  readonly codeOrWorkThreadProjectId?: (threadId: string) => string | undefined;
}

export function createBrowserAutomationRouteHandler(
  dependencies: BrowserAutomationRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const withAvailability = (windowId: WindowId, snapshot: BrowserAutomationSnapshot) => ({
    ...snapshot,
    agentAvailability: dependencies.agentAvailability?.(windowId, snapshot.threadId) ?? {
      status: "unknown" as const,
    },
  });
  const notThisWindowsThread = (origin: string | null): Response =>
    failure(
      { category: "unauthorized", message: "Browser thread is not owned by this window." },
      403,
      origin,
    );
  // A capture is a picture of a page the person browsed, so only a local
  // window that can open the thread reads one: not a paired device, and not a
  // window of another thread. The thread need not be live: captures are its
  // history, and an archived thread opened from the archive still shows them.
  // A paired browser has no desktop layout, so who asked decides it with the
  // scope: without the device, a Chat thread would look closed to it.
  const captureReadRefusal = async (
    windowId: WindowId,
    principal: ClientPrincipal,
    threadId: BrowserThreadId,
    origin: string | null,
  ): Promise<Response | undefined> =>
    principalActsAsHostPerson(principal) &&
    (await dependencies.windowCanOpenThread?.(windowId, threadId, principal)) === true
      ? undefined
      : notThisWindowsThread(origin);
  // Taking a capture drives the Browser, so it needs the thread's live Browser
  // authority, which reading does not.
  const captureTakeRefusal = (
    windowId: WindowId,
    canActAsPerson: boolean,
    threadId: BrowserThreadId,
    origin: string | null,
  ): Response | undefined =>
    canActAsPerson &&
    BROWSER_MODES.some((mode) => dependencies.authority.canAccessWindow(windowId, threadId, mode))
      ? undefined
      : notThisWindowsThread(origin);

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure({ category: "unauthorized", message: "Browser origin is not allowed." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure(
        { category: "invalid", message: "Browser route method is invalid." },
        405,
        origin,
      );
    }

    let windowId;
    let callerKind: "local-window" | "remote-device";
    let authenticatedPrincipal: ClientPrincipal;
    let authorityKind: "local-window" | "person-paired-device" | "remote-device";
    // A device the host's own person paired, judged as the person where a
    // route says so; it stays the principal and the actor.
    let actsAsHostPerson: boolean;
    let hubIntroduced: boolean;
    // Who the journal names for what this request changes: the device, when a
    // device asked.
    let actor: EventActor;
    let sessionNow: (() => number) | undefined;
    try {
      const principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: Date.now(),
      });
      windowId = principal.scopeId;
      authenticatedPrincipal = principal.principal;
      callerKind = principal.principal.kind;
      authorityKind = principalAuthorityKind(principal.principal);
      actsAsHostPerson = principalActsAsHostPerson(principal.principal);
      hubIntroduced = principalIsHubIntroduced(principal.principal);
      actor = eventActorForPrincipal(principal.principal);
      sessionNow = principal.sessionNow;
    } catch {
      if (
        url.pathname === "/api/browser/remote-control/input" ||
        url.pathname === "/api/browser/remote-control/stream" ||
        url.pathname === "/api/browser/remote-control/file"
      ) {
        return pairedControlJson(
          { status: "refused", reason: "remote-control-not-person" },
          403,
          origin,
        );
      }
      return failure(
        { category: "unauthorized", message: "Window authority is invalid." },
        401,
        origin,
      );
    }

    const pairedActor = (): PairedBrowserActor | undefined => {
      if (authenticatedPrincipal.kind !== "remote-device") return undefined;
      const remote = authenticatedPrincipal;
      const deviceId = String(remote.deviceId);
      return {
        principalKind: principalAuthorityKind(remote),
        isAgentGrant: isAgentGrantSession(remote),
        deviceId,
        deviceName: dependencies.resolvePairedDeviceName?.(deviceId) ?? "Paired device",
        sessionId: String(remote.sessionId),
        credentialGeneration: remote.credentialGeneration,
        current: () =>
          dependencies.isPairedDeviceSessionCurrent === undefined
            ? true
            : dependencies.isPairedDeviceSessionCurrent(remote, sessionNow),
      };
    };

    const flowSessionFingerprint =
      authenticatedPrincipal.kind === "remote-device"
        ? `${String(authenticatedPrincipal.deviceId)}:${String(authenticatedPrincipal.sessionId)}:${authenticatedPrincipal.credentialGeneration}`
        : undefined;

    if (url.pathname === "/api/browser/remote-control/file") {
      const remote = pairedActor();
      if (
        remote === undefined ||
        remote.principalKind !== "person-paired-device" ||
        remote.isAgentGrant === true
      ) {
        return pairedControlJson(
          { status: "refused", reason: "remote-control-not-person" },
          403,
          origin,
        );
      }
      if (dependencies.pairedBrowserControl === undefined) {
        return pairedControlJson({ status: "refused", reason: "page-not-here" }, 503, origin);
      }
      let leaseId;
      let chooserId;
      try {
        leaseId = decodePairedBrowserLeaseId(
          request.headers.get("x-octant-browser-lease-id") ?? "",
        );
        chooserId = decodePairedBrowserChooserId(
          request.headers.get("x-octant-browser-chooser-id") ?? "",
        );
      } catch {
        return failure(
          { category: "invalid", message: "Browser file-choice headers are invalid." },
          400,
          origin,
        );
      }
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PAIRED_BROWSER_FILE_BYTES) {
        return pairedControlJson({ status: "refused", reason: "rate-limited" }, 413, origin);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PAIRED_BROWSER_FILE_BYTES) {
        return pairedControlJson({ status: "refused", reason: "rate-limited" }, 413, origin);
      }
      const fileName = request.headers.get("x-octant-browser-file-name") ?? "upload.bin";
      const result = await dependencies.pairedBrowserControl.uploadFile(remote, {
        leaseId,
        chooserId,
        fileName,
        bytes,
        signal: request.signal,
      });
      return pairedControlResponse(result, origin);
    }

    const decoded = await readJson(request, dependencies.maxRequestBodySize);
    if (decoded.kind !== "ok") {
      return failure(
        {
          category: "invalid",
          message:
            decoded.kind === "too-large"
              ? "Browser request is too large."
              : "Browser request is invalid.",
        },
        decoded.kind === "too-large" ? 413 : 400,
        origin,
      );
    }

    if (url.pathname === "/api/browser/remote-control/input") {
      const remote = pairedActor();
      if (
        remote === undefined ||
        remote.principalKind !== "person-paired-device" ||
        remote.isAgentGrant === true
      ) {
        return pairedControlJson(
          { status: "refused", reason: "remote-control-not-person" },
          403,
          origin,
        );
      }
      if (dependencies.pairedBrowserControl === undefined) {
        return pairedControlJson({ status: "refused", reason: "page-not-here" }, 503, origin);
      }
      let command;
      try {
        command = decodePairedBrowserRequest(decoded.value);
      } catch {
        return failure(
          { category: "invalid", message: "Browser remote-control request is invalid." },
          400,
          origin,
        );
      }
      if (
        command.kind === "take-over" &&
        !BROWSER_MODES.some((mode) =>
          dependencies.authority.canAccessWindow(windowId, command.target.threadId, mode),
        )
      ) {
        return pairedControlJson({ status: "refused", reason: "authority-ended" }, 403, origin);
      }
      const result = await dependencies.pairedBrowserControl.execute(
        remote,
        command,
        request.signal,
      );
      return pairedControlResponse(result, origin);
    }

    if (url.pathname === "/api/browser/remote-control/stream") {
      const remote = pairedActor();
      if (
        remote === undefined ||
        remote.principalKind !== "person-paired-device" ||
        remote.isAgentGrant === true
      ) {
        return pairedControlJson(
          { status: "refused", reason: "remote-control-not-person" },
          403,
          origin,
        );
      }
      if (dependencies.pairedBrowserControl === undefined) {
        return pairedControlJson({ status: "refused", reason: "page-not-here" }, 503, origin);
      }
      let streamCommand;
      try {
        streamCommand = decodePairedBrowserStreamRequest(decoded.value);
      } catch {
        return failure(
          { category: "invalid", message: "Browser remote-control stream request is invalid." },
          400,
          origin,
        );
      }
      const opened = dependencies.pairedBrowserControl.openStream(
        remote,
        streamCommand.leaseId,
        request.signal,
      );
      if (opened.status === "refused") {
        return pairedControlResponse(opened, origin);
      }
      return new Response(opened.stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          ...corsHeaders(origin),
        },
      });
    }

    // A hub-introduced or restricted device sees that a signed-in page exists
    // and nothing it shows; the host's own person (at a local window or on a
    // device they paired) sees the page.
    const shown = (snapshot: BrowserAutomationSnapshot): BrowserAutomationSnapshot =>
      !actsAsHostPerson ? withheldFromRemote(snapshot) : snapshot;
    const personCaller: "local-window" | "remote-device" = actsAsHostPerson
      ? "local-window"
      : "remote-device";
    try {
      if (
        url.pathname === "/api/browser/task-profile/current" ||
        url.pathname === "/api/browser/task-profile"
      ) {
        const selecting = url.pathname === "/api/browser/task-profile";
        const command = selecting
          ? decodeBrowserTaskProfileSelectCommand(decoded.value)
          : decodeBrowserTaskProfileReadCommand(decoded.value);
        if (
          !actsAsHostPerson ||
          !dependencies.authority.canAccessWindow(windowId, command.threadId, command.mode)
        )
          return notThisWindowsThread(origin);
        const profiles = dependencies.taskProfiles;
        if (profiles === undefined || dependencies.service.switchTaskProfile === undefined)
          return failure(
            { category: "unavailable", message: "Task Browser profile controls are unavailable." },
            503,
            origin,
          );
        const current = profiles.read(command.threadId, command.mode);
        const authority = dependencies.authority.resolve(command.threadId, command.mode);
        if (current === undefined || authority === undefined) return notThisWindowsThread(origin);
        const state = () => {
          const value = profiles.read(command.threadId, command.mode);
          if (value === undefined) throw new Error("Task changed");
          const context = dependencies.service.inspectThread(windowId, command.threadId).context;
          return decodeBrowserTaskProfileState({
            threadId: command.threadId,
            mode: command.mode,
            version: value.version,
            profile: value.profile,
            ...(context?.state === "active" ? { contextId: context.contextId } : {}),
          });
        };
        if (!selecting) return success(state(), origin);
        const selection = decodeBrowserTaskProfileSelectCommand(command);
        if (current.version !== selection.expectedVersion)
          return failure(
            { category: "stale", message: "The task changed. Reload before choosing a profile." },
            409,
            origin,
          );
        const profile = browserProfileFromChoice(selection.profile, authority.projectId);
        if (profile === undefined)
          return failure(
            { category: "unavailable", message: "This task has no Project Browser profile." },
            409,
            origin,
          );
        const result = await dependencies.service.switchTaskProfile({
          windowId,
          threadId: selection.threadId,
          action: {
            actionId: randomUUID() as never,
            correlationId: randomUUID() as never,
            capability: { id: "browser-automation" as never, version: 1 },
            authority,
            intent: "Choose this task's default Browser profile.",
            approval: { kind: "not-required" },
          },
          profile,
          ...(selection.expectedContextId === undefined
            ? {}
            : { expectedContextId: selection.expectedContextId }),
          ...(selection.url === undefined ? {} : { url: selection.url }),
          actor,
          isCurrent: () => {
            const live = profiles.read(selection.threadId, selection.mode);
            const granted = dependencies.authority.resolve(selection.threadId, selection.mode);
            return (
              live?.version === current.version &&
              live.modelId === current.modelId &&
              granted !== undefined &&
              dependencies.authority.canAccessWindow(
                windowId,
                selection.threadId,
                selection.mode,
              ) &&
              sameToolActionAuthority(authority, granted)
            );
          },
          save: (commit) => profiles.save(windowId, selection, commit),
          bind: (contextId, bindingAuthority) =>
            profiles.bind(String(contextId), current.modelId, bindingAuthority),
        });
        if (result.status === "refused")
          return failure(
            result.failure,
            result.failure.category === "unauthorized" ? 403 : 409,
            origin,
          );
        return success(
          decodeBrowserTaskProfileSelection({ selection: state(), browser: result.browser }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/credential-use") {
        if (callerKind !== "local-window" || !isLoopbackHostname(url.hostname))
          return failure(
            {
              category: "unauthorized",
              message: "Login permission requires a local window on this computer.",
            },
            403,
            origin,
          );
        if (dependencies.credentialUse === undefined)
          return failure(
            { category: "unavailable", message: "Login permissions are unavailable." },
            503,
            origin,
          );
        return success(
          decodeBrowserCredentialResult(
            await dependencies.credentialUse.execute(
              windowId,
              decodeBrowserCredentialCommand(decoded.value),
              request.signal,
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/project-contexts") {
        if (dependencies.projectBrowsers === undefined) {
          return failure(
            { category: "unavailable", message: "Project browsers are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeProjectBrowserCommand(decoded.value);
        // A device the host's own person paired opens Project pages (Private or
        // stored profiles) as a local window does; restricted devices stay refused.
        return success(
          decodeProjectBrowserResult(
            await dependencies.projectBrowsers.execute(windowId, personCaller, command),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/project-agent-pages") {
        const pages = dependencies.projectAgentPages;
        if (pages === undefined || dependencies.service.listProjectAgentPages === undefined) {
          return failure(
            { category: "unavailable", message: "Project agent pages are unavailable." },
            503,
            origin,
          );
        }
        const input = decodeProjectAgentPagesCommand(decoded.value);
        // The window must hold the Project, and each thread's page is listed
        // only when the window also holds that thread's live Browser
        // authority: knowing a Project's id shows nothing of its threads.
        if (!(await pages.windowCanOpenProject(windowId, String(input.projectId)))) {
          return notThisWindowsThread(origin);
        }
        return success(
          decodeProjectAgentPages({
            projectId: input.projectId,
            mode: input.mode,
            pages: dependencies.service.listProjectAgentPages({
              windowId,
              projectId: String(input.projectId),
              mode: input.mode,
              threadTitle: (threadId) =>
                dependencies.authority.canAccessWindow(windowId, threadId, input.mode)
                  ? pages.threadTitle(threadId, input.mode)
                  : undefined,
              remote: !actsAsHostPerson,
            }),
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/extensions") {
        if (dependencies.extensions === undefined) {
          return failure(
            { category: "unavailable", message: "Browser extensions are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeBrowserExtensionsCommand(decoded.value);
        return success(
          decodeBrowserExtensionsResult(
            await dependencies.extensions.execute(windowId, personCaller, command, actor),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/profiles") {
        if (dependencies.profiles === undefined) {
          return failure(
            { category: "unavailable", message: "Browser profiles are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeBrowserProfilesCommand(decoded.value);
        return success(
          decodeBrowserProfilesResult(
            await dependencies.profiles.execute(authorityKind, command, actor),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/flows") {
        if (dependencies.flows === undefined) {
          return failure(
            { category: "unavailable", message: "Browser flows are unavailable." },
            503,
            origin,
          );
        }
        const command = decodeBrowserFlowsCommand(decoded.value);
        // Flows are a Project's data that a replay would navigate and type
        // from; only the host's own person (at a local window or on a device
        // they paired) may list, run, save, or delete them.
        if (!actsAsHostPerson) {
          return success(
            decodeBrowserFlowsResult({
              kind: "browser-flows-refused",
              reason: "not-local",
              message: "Browser flows are managed only on this Mac.",
            }),
            origin,
          );
        }
        if (command.kind === "list") {
          return success(
            decodeBrowserFlowsResult({
              kind: "browser-flows",
              flows: dependencies.flows.summaries(),
            }),
            origin,
          );
        }
        if (command.kind !== "delete") {
          const runs = dependencies.flowRuns;
          if (runs === undefined)
            return failure(
              { category: "unavailable", message: "Reviewed Browser flow runs are unavailable." },
              503,
              origin,
            );
          const result =
            command.kind === "run-tasks"
              ? runs.tasks(windowId, command.projectId)
              : command.kind === "review-run"
                ? runs.review(
                    windowId,
                    command.projectId,
                    command.name,
                    {
                      threadId: command.threadId,
                      mode: command.mode,
                    },
                    flowSessionFingerprint,
                  )
                : command.kind === "start-run"
                  ? await runs.start(
                      windowId,
                      command.runId,
                      command.values,
                      flowSessionFingerprint,
                    )
                  : command.kind === "resume-run"
                    ? await runs.resume(windowId, command.runId, flowSessionFingerprint)
                    : command.kind === "cancel-run"
                      ? runs.cancel(windowId, command.runId, flowSessionFingerprint)
                      : runs.inspect(windowId, command.runId, flowSessionFingerprint);
          return success(decodeBrowserFlowsResult(result), origin);
        }
        return success(
          decodeBrowserFlowsResult(
            dependencies.flows.delete(command.projectId, command.name, actor)
              ? { kind: "browser-flow-deleted", projectId: command.projectId, name: command.name }
              : {
                  kind: "browser-flows-refused",
                  reason: "not-found",
                  message: "That flow no longer exists.",
                },
          ),
          origin,
        );
      }
      // Download, upload and session permissions are reviewed by the host's
      // own person: at a window on this host or on a device that person paired
      // (maintainer decision, 2026-11-12). Each service checks the scope it is
      // handed against the host's own record again, and its journal names the
      // device.
      if (url.pathname === "/api/browser/download-permissions") {
        if (boundPrincipalIsRestricted(request))
          return success(
            decodeBrowserDownloadPermissionsResult({
              kind: "download-permission-refused",
              reason: "not-local",
              message: "Download manifests are reviewed only on the execution host.",
            }),
            origin,
          );
        if (dependencies.downloadPermissions === undefined)
          return failure(
            { category: "unavailable", message: "Recurring download permissions are unavailable." },
            503,
            origin,
          );
        return success(
          decodeBrowserDownloadPermissionsResult(
            await dependencies.downloadPermissions.execute(
              windowId,
              decodeBrowserDownloadPermissionsCommand(decoded.value),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/upload-permissions") {
        if (boundPrincipalIsRestricted(request))
          return success(
            decodeBrowserUploadPermissionsResult({
              kind: "upload-permission-refused",
              reason: "not-local",
              message: "Upload manifests are reviewed only on the execution host.",
            }),
            origin,
          );
        if (dependencies.uploadPermissions === undefined)
          return failure(
            { category: "unavailable", message: "Recurring upload permissions are unavailable." },
            503,
            origin,
          );
        return success(
          decodeBrowserUploadPermissionsResult(
            await dependencies.uploadPermissions.execute(
              windowId,
              decodeBrowserUploadPermissionsCommand(decoded.value),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/session-grants") {
        if (boundPrincipalIsRestricted(request))
          return success(
            decodeBrowserSessionGrantsResult({
              kind: "browser-session-refused",
              reason: "not-local",
              message: "Session permissions are reviewed only on the execution host.",
            }),
            origin,
          );
        if (dependencies.sessionGrants === undefined)
          return failure(
            { category: "unavailable", message: "Browser session permissions are unavailable." },
            503,
            origin,
          );
        return success(
          decodeBrowserSessionGrantsResult(
            await dependencies.sessionGrants.execute(
              windowId,
              decodeBrowserSessionGrantsCommand(decoded.value),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/approvals") {
        if (dependencies.approvals === undefined) {
          return failure(
            { category: "unavailable", message: "Browser approval is unavailable." },
            503,
            origin,
          );
        }
        if (
          typeof decoded.value === "object" &&
          decoded.value !== null &&
          (decoded.value as { kind?: unknown }).kind === "list"
        ) {
          return success(dependencies.approvals.list(windowId), origin);
        }
        if ((decoded.value as { kind?: unknown }).kind !== "decide") {
          return failure(
            { category: "invalid", message: "Browser approval decision is invalid." },
            400,
            origin,
          );
        }
        const { kind: _kind, ...rawDecision } = decoded.value as Record<string, unknown>;
        const decision = decodeBrowserToolApprovalDecision(rawDecision);
        // A device only the hub introduced answers a Code or Work thread's
        // prompt only in a Project the member's Act item names, read at this
        // answer. A prompt it may not answer is refused by the service anyway,
        // and Chat is not held to the Act item.
        if (hubIntroduced) {
          const prompt = dependencies.approvals
            .list(windowId)
            .find((listed) => String(listed.approvalId) === String(decision.approvalId));
          const refusal =
            prompt === undefined || prompt.mode === "chat"
              ? undefined
              : hubActRefusal(
                  dependencies.hubActScope?.(),
                  dependencies.codeOrWorkThreadProjectId?.(String(prompt.threadId)),
                  "answer",
                );
          if (refusal !== undefined) {
            return failure({ category: "unauthorized", message: refusal }, 403, origin);
          }
        }
        const accepted = dependencies.approvals.decide(windowId, decision);
        return success({ accepted }, origin, accepted ? 200 : 409);
      }
      if (url.pathname === "/api/browser/scope") {
        const input = decodeBrowserThreadScopeRequest(decoded.value);
        if (!dependencies.authority.canAccessWindow(windowId, input.threadId, input.mode)) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        const authority = dependencies.authority.resolve(input.threadId, input.mode);
        if (authority === undefined) {
          return failure(
            { category: "unauthorized", message: "Browser thread authority is unavailable." },
            403,
            origin,
          );
        }
        return success(decodeBrowserThreadScope({ threadId: input.threadId, authority }), origin);
      }
      if (url.pathname === "/api/browser/contexts") {
        const input = decodeBrowserContextCreateCommand(decoded.value);
        if (
          !dependencies.authority.canAccessWindow(
            windowId,
            input.threadId,
            input.action.authority.mode,
          )
        ) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        const reopenHold =
          input.reopenPageId !== undefined && actsAsHostPerson
            ? dependencies.pageOffers?.holdForOpen(windowId, {
                threadId: input.threadId,
                mode: input.action.authority.mode === "code" ? "code" : "work",
                pageId: input.reopenPageId,
              })
            : undefined;
        if (reopenHold === "held-by-other") {
          return failure(
            {
              category: "unavailable",
              message:
                "Another window or device is reopening this page. Try again once it has finished.",
            },
            409,
            origin,
          );
        }
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.create({
              windowId,
              ...input,
              // The one route a person opens a page from. Every other caller
              // of `create` leaves this unsaid, so only this page is recorded
              // as the person's.
              openedByPerson: true,
              actor,
              // Honoured only while this window or device holds the page's
              // reservation, which an open that names it takes again if it
              // lapsed; otherwise it is an ordinary open.
              ...(reopenHold === "held" && input.reopenPageId !== undefined
                ? { reopensPageId: String(input.reopenPageId) }
                : {}),
              // A signed-in page opens for the host's own person (at a local
              // window or on a device they paired); a hub-introduced or
              // restricted device is refused before any runtime is asked.
              ...(callerKind === "remote-device"
                ? {
                    profileCaller: actsAsHostPerson
                      ? ("person-paired-device" as const)
                      : ("remote-device" as const),
                  }
                : {}),
            }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/inspect") {
        const input = decodeBrowserContextInspectCommand(decoded.value);
        // The Browser pane polls this once it holds a context's id, so this is
        // where its picture of a headless page is refreshed after an agent's
        // action, which takes none.
        return success(
          shown(
            decodeBrowserAutomationSnapshot(
              withAvailability(
                windowId,
                dependencies.service.peekContext === undefined
                  ? dependencies.service.inspect(windowId, input.threadId, input.contextId)
                  : await dependencies.service.peekContext(
                      windowId,
                      input.threadId,
                      input.contextId,
                      request.signal,
                      input.freshPicture === undefined ? {} : { freshPicture: input.freshPicture },
                    ),
              ),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/current") {
        const input = decodeBrowserThreadInspectCommand(decoded.value);
        if (
          !BROWSER_MODES.some((mode) =>
            dependencies.authority.canAccessWindow(windowId, input.threadId, mode),
          )
        ) {
          return failure(
            { category: "unauthorized", message: "Browser thread is not owned by this window." },
            403,
            origin,
          );
        }
        // The preview polls this route, so it is where a page the person
        // drives gets its picture refreshed.
        const snapshot =
          dependencies.service.peekThread === undefined || input.freshPicture === false
            ? dependencies.service.inspectThread(windowId, input.threadId)
            : await dependencies.service.peekThread(windowId, input.threadId, request.signal);
        // The offer is the host's person's: a below-Full, restricted or
        // hub-introduced device is shown none.
        const reopenOffer = actsAsHostPerson
          ? await dependencies.pageOffers?.read(windowId, input.threadId)
          : undefined;
        return success(
          shown(
            decodeBrowserAutomationSnapshot({
              ...withAvailability(windowId, snapshot),
              ...(reopenOffer === undefined ? {} : { reopenOffer }),
            }),
          ),
          origin,
        );
      }
      if (
        url.pathname === "/api/browser/page-offer/claim" ||
        url.pathname === "/api/browser/page-offer/release" ||
        url.pathname === "/api/browser/page-offer/dismiss"
      ) {
        const input = decodeBrowserPageOfferCommand(decoded.value);
        // Refused before any record is read or changed.
        if (!actsAsHostPerson || dependencies.pageOffers === undefined) {
          return success({ status: "refused", reason: "not-allowed" }, origin);
        }
        return success(
          url.pathname === "/api/browser/page-offer/claim"
            ? await dependencies.pageOffers.claim(windowId, input)
            : url.pathname === "/api/browser/page-offer/release"
              ? dependencies.pageOffers.release(windowId, input)
              : dependencies.pageOffers.dismiss(windowId, input, actor),
          origin,
        );
      }
      if (url.pathname === "/api/browser/captures") {
        const input = decodeBrowserCapturesCommand(decoded.value);
        const refusal = await captureReadRefusal(
          windowId,
          authenticatedPrincipal,
          input.threadId,
          origin,
        );
        if (refusal !== undefined) return refusal;
        return success(
          decodeBrowserCapturesResponse({
            captures: dependencies.captures?.list(input.threadId) ?? [],
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/steps") {
        // The step list is the Browser's history beside the captures, so it
        // answers the same callers: a local window or person-paired device.
        const input = decodeBrowserStepsCommand(decoded.value);
        const refusal = await captureReadRefusal(
          windowId,
          authenticatedPrincipal,
          input.threadId,
          origin,
        );
        if (refusal !== undefined) return refusal;
        return success(
          decodeBrowserStepsResponse({
            steps: dependencies.captures?.listSteps(input.threadId) ?? [],
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/captures/take") {
        // The person's Screenshot control. The ordinary action route keeps
        // nothing, and a model cannot reach this path through tool input.
        const input = decodeBrowserCaptureTakeCommand(decoded.value);
        const refusal = captureTakeRefusal(windowId, actsAsHostPerson, input.threadId, origin);
        if (refusal !== undefined) return refusal;
        if (input.request.kind !== "screenshot") {
          return failure(
            { category: "invalid", message: "Only a screenshot can be taken as a capture." },
            400,
            origin,
          );
        }
        // The context must be this thread's, not merely this window's.
        const owned = dependencies.service.inspect(
          windowId,
          input.threadId,
          input.request.contextId,
        );
        if (owned.failure?.category === "unauthorized") {
          return failure(owned.failure, 403, origin);
        }
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.act({
              windowId,
              request: input.request,
              capturedBy: "person",
              capturedByActor: actor,
            }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/captures/image") {
        const input = decodeBrowserCaptureImageCommand(decoded.value);
        const refusal = await captureReadRefusal(
          windowId,
          authenticatedPrincipal,
          input.threadId,
          origin,
        );
        if (refusal !== undefined) return refusal;
        const found = await dependencies.captures?.read(input.threadId, input.captureId);
        if (found === undefined) {
          return failure(
            { category: "unavailable", message: "The browser capture is unavailable." },
            404,
            origin,
          );
        }
        return success(
          decodeBrowserCaptureImage({
            captureId: input.captureId,
            dataUrl: `data:${found.capture.mime};base64,${Buffer.from(found.bytes).toString("base64")}`,
          }),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/release") {
        const input = decodeBrowserThreadContextCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.releaseThread(windowId, input.threadId, "person", actor),
          ),
          origin,
        );
      }
      if (
        url.pathname === "/api/browser/contexts/take-over" ||
        url.pathname === "/api/browser/contexts/hand-back"
      ) {
        const input = decodeBrowserThreadContextCommand(decoded.value);
        const isTakeOver = url.pathname === "/api/browser/contexts/take-over";
        if (callerKind === "remote-device") {
          const remote = pairedActor();
          if (
            remote === undefined ||
            remote.principalKind !== "person-paired-device" ||
            remote.isAgentGrant === true
          ) {
            return pairedControlJson(
              { status: "refused", reason: "remote-control-not-person" },
              403,
              origin,
            );
          }
          if (
            !BROWSER_MODES.some((mode) =>
              dependencies.authority.canAccessWindow(windowId, input.threadId, mode),
            )
          ) {
            return notThisWindowsThread(origin);
          }
          if (dependencies.pairedBrowserControl === undefined) {
            return failure(
              { category: "unavailable", message: "Taking over the page is unavailable." },
              503,
              origin,
            );
          }
          if (isTakeOver) {
            const held = await dependencies.pairedBrowserControl.takeOver(
              remote,
              input.threadId,
              request.signal,
            );
            if (held.status !== "held") {
              return pairedControlResponse(held, origin);
            }
            const currentSnapshot = dependencies.service.inspectThread(windowId, input.threadId);
            return success(
              decodeBrowserAutomationSnapshot({
                ...withAvailability(windowId, currentSnapshot),
                pairedLease: {
                  leaseId: held.leaseId,
                  expiresAt: held.expiresAt,
                  target: held.target,
                },
              }),
              origin,
            );
          }
          const handed = await dependencies.pairedBrowserControl.handBackForThread(
            remote,
            input.threadId,
            input.leaseId,
          );
          if (handed.status !== "released") {
            return pairedControlResponse(handed, origin);
          }
          return success(
            decodeBrowserAutomationSnapshot(
              withAvailability(
                windowId,
                dependencies.service.inspectThread(windowId, input.threadId),
              ),
            ),
            origin,
          );
        }
        if (
          !BROWSER_MODES.some((mode) =>
            dependencies.authority.canAccessWindow(windowId, input.threadId, mode),
          )
        ) {
          return notThisWindowsThread(origin);
        }
        const hold = isTakeOver ? dependencies.service.takeOver : dependencies.service.handBack;
        if (hold === undefined) {
          return failure(
            { category: "unavailable", message: "Taking over the page is unavailable." },
            503,
            origin,
          );
        }
        const answered = decodeBrowserAutomationSnapshot(
          hold.call(dependencies.service, windowId, input.threadId),
        );
        if (answered.failure !== undefined) {
          return failure(
            answered.failure,
            answered.failure.category === "unauthorized" ? 403 : 409,
            origin,
          );
        }
        return success(answered, origin);
      }
      if (url.pathname === "/api/browser/actions") {
        const input = decodeBrowserActionCommand(decoded.value);
        // A paired device acts inside the view the host opened. The gateway
        // already admitted this route for a remote principal; the kind it may
        // carry is decided here, where the principal is known, so a companion
        // client can never navigate, type, or close a tab on the host.
        if (boundPrincipalIsRestricted(request)) {
          const reach = remoteBrowserActionReach(input.kind);
          if (reach.kind === "denied") {
            return failure({ category: "unauthorized", message: reach.reason }, 403, origin);
          }
          // A tap on a signed-in page would act as the person's account from a
          // device that cannot even see the page.
          if (
            storedBrowserProfile(dependencies.service.profileOf?.(input.contextId)) !== undefined
          ) {
            return failure(
              {
                category: "policy-denied",
                reason: "profile-not-local",
                message: "Signed-in page — open it on this Mac.",
              },
              403,
              origin,
            );
          }
        }
        // A person driving a headless page sees it only as a picture, so their
        // action brings one back; an agent's action does so only when asked.
        const include = input.include ?? [];
        const pictured = include.includes("screenshot")
          ? input
          : { ...input, include: [...include, "screenshot" as const] };
        return success(
          shown(
            decodeBrowserAutomationSnapshot(
              await dependencies.service.act({
                windowId,
                request: pictured,
                // The person's own typed address: a window of this computer,
                // or a device the host's own person paired at Full, which is
                // that person (maintainer decision, 2026-11-26). Its redirects
                // are the person's, as in their own browser. A restricted or
                // hub-introduced device keeps the approved-origin rule.
                ...(actsAsHostPerson && pictured.kind === "navigate"
                  ? { startedBy: "person" as const }
                  : {}),
              }),
            ),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/cancel") {
        const input = decodeBrowserContextCancelCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.cancel({ windowId, ...input }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/stop") {
        const input = decodeBrowserContextStopCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.stop(
              windowId,
              input.threadId,
              input.contextId,
              "person",
              actor,
            ),
          ),
          origin,
        );
      }
      return undefined;
    } catch (error) {
      if (error instanceof Error && /stale|unknown/i.test(error.message)) {
        return failure(
          { category: "stale", message: "Browser context is stale or no longer owned." },
          409,
          origin,
        );
      }
      if (error instanceof Error && /ParseError/.test(error.name)) {
        return failure(
          { category: "invalid", message: "Browser request is invalid." },
          400,
          origin,
        );
      }
      return failure(
        { category: "failed", message: "Browser automation service failed closed." },
        503,
        origin,
      );
    }
  };
}

/**
 * What a paired device may see of a page in a signed-in profile: that it exists,
 * and nothing it shows. The picture, the text, the address, and the title all
 * carry the account, so none of them leaves this Mac.
 */
export function withheldFromRemote(snapshot: BrowserAutomationSnapshot): BrowserAutomationSnapshot {
  if (storedBrowserProfile(snapshot.context?.policy.profile) === undefined) return snapshot;
  const { observation: _observation, contexts: _contexts, ...rest } = snapshot;
  return {
    ...rest,
    evidence: [],
    failure: {
      category: "policy-denied",
      reason: "profile-not-local",
      message: "Signed-in page — open it on this Mac.",
    },
  };
}

function success(value: unknown, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(
  input: BrowserAutomationFailure,
  status: number,
  origin?: string | null,
): Response {
  return new Response(JSON.stringify(decodeBrowserAutomationFailure(input)), {
    status,
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : corsHeaders(origin)),
    },
  });
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: text === "" ? {} : JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type, retry-after",
  };
}

function pairedControlJson(
  payload: PairedBrowserResponse,
  status: number,
  origin: string | null,
  retryAfterSeconds?: number,
): Response {
  return new Response(JSON.stringify(decodePairedBrowserResponse(payload)), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
      ...corsHeaders(origin),
    },
  });
}

function pairedControlResponse(result: PairedBrowserResponse, origin: string | null): Response {
  if (result.status !== "refused") {
    return pairedControlJson(result, 200, origin);
  }
  const status =
    result.reason === "remote-control-not-person" || result.reason === "authority-ended"
      ? 403
      : result.reason === "rate-limited"
        ? 429
        : 409;
  return pairedControlJson(result, status, origin, result.retryAfterSeconds);
}
