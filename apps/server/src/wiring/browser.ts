import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decodeAggregateVersion,
  decodeCodeThreadId,
  LOCAL_HOST_ID,
  type ProjectId,
  sameToolActionAuthority,
  type WindowId,
} from "@octant/contracts";
import { Effect } from "effect";
import { createProductFeedbackRouteHandler } from "../productFeedbackRoutes";
import {
  decodeBrowserContextId,
  decodeBrowserThreadId,
} from "@octant/contracts/browser-automation";
import { decodeCodeEvidenceReference } from "@octant/contracts/code-operations";
import { ProductFeedbackService } from "../browser/productFeedbackService";
import { isRoutineHostScope } from "../routineHostScope";
import { ProjectBrowserService } from "../browser/projectBrowserService";
import { OCTANT_LOCAL_ACTOR_ID, ShellServiceError } from "../shellService";
import {
  BrowserAutomationService,
  createBrowserToolCallAuthorityService,
} from "../browser/browserAutomationService";
import { BrowserToolApprovalService } from "../browser/browserToolApprovalService";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import {
  deriveToolHostId,
  ServerBrowserAuthorityResolver,
} from "../browser/browserAuthorityResolver";
import { createPlaywrightBrowserRuntime } from "../browser/playwrightBrowserRuntime";
import { createDesktopBrowserRuntimeFromEnvironment } from "../browser/desktopBrowserRuntime";
import { RoutingBrowserRuntime } from "../browser/routingBrowserRuntime";
import { defaultShellSettings, enabledModes } from "@octant/domain";
import type { ServerStart } from "./serverShape";
import type { LateBindings } from "./lateBindings";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { ProvidersWiring } from "./providers";

export type BrowserDependencies = Pick<ServerStart, "options" | "persistence"> & {
  /** Cells settled by a later wiring call; read per use, never at construction. */
  readonly late: Pick<
    LateBindings,
    "browserAutomationService" | "browserToolApprovalService" | "projectBrowserService"
  >;
} & Pick<AuthorityWiring, "browserCaptures" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<WorkspaceWiring, "projectService" | "shellService" | "workThreadProjection"> &
  Pick<CodeWiring, "codeEvidence"> &
  Pick<ProvidersWiring, "providerDataDirectory">;

export function wireBrowser(deps: BrowserDependencies) {
  const {
    late,
    browserCaptures,
    codeEvidence,
    externalContentIngestionStore,
    options,
    persistence,
    projectService,
    providerDataDirectory,
    shellService,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;
  return Effect.gen(function* () {
    const browserAuthority = new ServerBrowserAuthorityResolver({
      hostId: deriveToolHostId(providerDataDirectory),
      workspaceHostId: LOCAL_HOST_ID,
      persistence,
      workThreads: workThreadProjection,
    });
    const rememberedBrowserOrigins = () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .rememberedBrowserOrigins;
    // An "always allow" answer journals the origin into shell settings through
    // the host-owned path — `replace-settings` itself cannot add origins, since
    // a window capability would let a client grant itself an origin the prompt
    // never showed. A concurrent settings write can lose the race, so the
    // append retries on the fresh version once. A window that went away between
    // prompt and answer cannot journal — its grant is then session-only, like
    // approve-once.
    const rememberBrowserOrigin = (windowId: WindowId, origin: string) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stored = persistence.readShellSettings();
        const current = stored?.settings ?? defaultShellSettings();
        if (current.rememberedBrowserOrigins.includes(origin)) return;
        try {
          shellService.rememberBrowserOrigins({
            windowId,
            expectedVersion: stored?.aggregateVersion ?? decodeAggregateVersion(0),
            origins: [origin],
          });
          return;
        } catch (error) {
          if (!(error instanceof ShellServiceError && error.failure.category === "conflict")) {
            console.warn(
              `Octant could not remember a browser origin approval: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
        }
      }
    };
    const browserToolApprovalService = new BrowserToolApprovalService({
      uuid: randomUUID,
      now: Date.now,
      authorityIsCurrent: (threadId, authority, windowId) => {
        const decodedThreadId = decodeBrowserThreadId(threadId);
        const current = browserAuthority.resolve(decodedThreadId, authority.mode);
        return (
          current !== undefined &&
          sameToolActionAuthority(current, authority) &&
          browserAuthority.canAccessWindow(windowId, decodedThreadId, authority.mode)
        );
      },
      rememberOrigin: (origin, windowId) => rememberBrowserOrigin(windowId, origin),
      isOriginRemembered: (origin) => rememberedBrowserOrigins().includes(origin),
      isHostScope: isRoutineHostScope,
    });
    late.browserToolApprovalService.current = browserToolApprovalService;
    const headlessBrowserRuntime = createPlaywrightBrowserRuntime({
      receiptDirectory: join(providerDataDirectory, "browser", "runtime-receipts"),
    });
    const desktopBrowserRuntime = createDesktopBrowserRuntimeFromEnvironment(process.env);
    const browserRuntime =
      options.browserRuntime ??
      (desktopBrowserRuntime === undefined
        ? headlessBrowserRuntime
        : new RoutingBrowserRuntime({
            native: desktopBrowserRuntime,
            headless: headlessBrowserRuntime,
          }));
    yield* Effect.promise(() => browserRuntime.reconcile?.() ?? Promise.resolve());
    // A person's own browser for a Work or Code Project, with no thread. It
    // shares the runtime, so shutdown closes its pages too, but it lives apart
    // from the thread-owned automation service so no agent tool can reach it.
    const windowHoldsProject = (
      windowId: WindowId,
      projectId: ProjectId,
      mode: "work" | "code",
    ): boolean => {
      const context = persistence.readWindowWorkspace(windowId)?.workspace.contextByMode[mode];
      return (
        context !== undefined &&
        context.mode === mode &&
        String(context.host) === String(LOCAL_HOST_ID) &&
        String(context.projectId) === String(projectId)
      );
    };
    const liveProjectBrowsers = new ProjectBrowserService({
      runtime: browserRuntime,
      readProject: persistence.readProject,
      canAccessProject: windowHoldsProject,
      isModeEnabled: (mode) =>
        enabledModes(persistence.readShellSettings()?.settings ?? defaultShellSettings()).includes(
          mode,
        ),
      uuid: randomUUID,
      now: Date.now,
    });
    const projectBrowserService = liveProjectBrowsers;
    late.projectBrowserService.current = projectBrowserService;
    // Every change that can take a page away from its window: the Project's
    // lifecycle or binding, the window moving to another Project, or its mode
    // being turned off.
    const unsubscribeProjectBrowserAuthority = persistence.journal.subscribeCommitted((append) => {
      if (
        append.events.some(
          (event) =>
            event.eventName === "project.lifecycle-changed@1" ||
            event.eventName === "project.binding-relinked@1" ||
            event.eventName === "workspace.layout-replaced" ||
            event.eventName === "shell.settings-replaced",
        )
      ) {
        void liveProjectBrowsers.settle();
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeProjectBrowserAuthority));
    const browserAutomationService = new BrowserAutomationService({
      runtime: browserRuntime,
      authority: browserAuthority,
      captures: browserCaptures,
      toolCallAuthority: createBrowserToolCallAuthorityService(
        browserAuthority,
        () => new Date().toISOString(),
        (threadId) => readThreadExternalContentTaint(persistence.connection, threadId),
        (threadId) => {
          const thread = persistence.readCodeThread(threadId as never);
          if (thread === undefined) return undefined;
          return {
            ...(thread.toolConstraints === undefined
              ? {}
              : { toolConstraints: thread.toolConstraints }),
            ...(thread.profileDisplayName === undefined
              ? {}
              : { profileDisplayName: thread.profileDisplayName }),
          };
        },
      ),
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      now: Date.now,
    });
    late.browserAutomationService.current = browserAutomationService;
    // Notes the user points at the running product. The service owns the
    // authority check and resolves the element itself; the crop lives in the
    // same purgeable evidence store the rest of Code's bulk content uses, and
    // the journal keeps only the reference.
    const productFeedbackService = new ProductFeedbackService({
      journal: persistence.journal,
      browser: {
        describePoint: async (input) =>
          (await browserAutomationService?.describePoint({
            windowId: input.windowId,
            threadId: decodeBrowserThreadId(input.threadId),
            contextId: decodeBrowserContextId(input.contextId),
            point: input.point,
          })) ?? { status: "unavailable" },
      },
      crops: {
        put: (dataUrl) => {
          const reference = codeEvidence.put(dataUrl);
          return {
            contentId: String(reference.contentId),
            digest: reference.digest,
            byteLength: reference.byteLength,
          };
        },
        read: (crop) => {
          try {
            return codeEvidence.read(
              decodeCodeEvidenceReference({
                contentId: crop.contentId,
                digest: crop.digest,
                byteLength: crop.byteLength,
              }),
            );
          } catch {
            return undefined;
          }
        },
      },
      readNote: (noteId) => persistence.readProductFeedbackNote(noteId),
      readNotes: (threadId) => persistence.readProductFeedbackNotes(threadId),
      canAccessThread: async (windowId, threadId) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
        if (thread === undefined) return false;
        return projectService.hasActiveProject(thread.projectId, "code");
      },
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const productFeedbackRoutes = createProductFeedbackRouteHandler({
      feedback: productFeedbackService,
      windowAuthorityStore,
    });
    return {
      browserAuthority,
      browserAutomationService,
      browserToolApprovalService,
      liveProjectBrowsers,
      productFeedbackRoutes,
      productFeedbackService,
      projectBrowserService,
      windowHoldsProject,
    };
  });
}

export type BrowserWiring = Effect.Effect.Success<ReturnType<typeof wireBrowser>>;
