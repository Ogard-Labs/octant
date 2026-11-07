import {
  currentRoutineBrowserTarget,
  routineBrowserExecutionIsCurrent,
} from "../browser/browserRoutineSessions";
import { deriveToolHostId } from "../browser/browserAuthorityResolver";
import type {
  AutomationRunReference,
  AutomationId,
  ToolActionAuthority,
  BrowserThreadId,
} from "@octant/contracts";
import type { BrowserRuntimePort } from "../browser/browserRuntimePort";
import { createNativeBrowserPresentationRoutes } from "../browser/nativeBrowserPresentationRoutes";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decodeAggregateVersion,
  decodeCodeThreadId,
  LOCAL_HOST_ID,
  type ProjectId,
  type StoredBrowserProfile,
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
import { BrowserExtensionService } from "../browser/browserExtensionService";
import { BrowserProfileService } from "../browser/browserProfileService";
import {
  BrowserFlowRecorder,
  BrowserFlowService,
  type BrowserFlowToolPort,
} from "../browser/browserFlows";
import { createBrowserCookieReader } from "../browser/cookieImport/browserCookieReader";
import { readKeychainPasswordWithSecurityTool } from "../browser/cookieImport/keychainPassword";
import { ProjectBrowserService } from "../browser/projectBrowserService";
import { OCTANT_LOCAL_ACTOR_ID, ShellServiceError } from "../shellService";
import {
  BrowserAutomationService,
  createBrowserToolCallAuthorityService,
} from "../browser/browserAutomationService";
import { BrowserToolApprovalService } from "../browser/browserToolApprovalService";
import { createBrowserCredentialUseService } from "../browser/browserCredentialUseService";
import { makeSecretStoreBrokerClient } from "../secretStores/secretStoreBrokerClient";
import { secretStoresJournal } from "../secretStores/secretStoresJournal";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { createPlaywrightBrowserRuntime } from "../browser/playwrightBrowserRuntime";
import { createDesktopBrowserRuntimeFromEnvironment } from "../browser/desktopBrowserRuntime";
import { RoutingBrowserRuntime } from "../browser/routingBrowserRuntime";
import {
  isToolAllowedByAllowlist,
  defaultShellSettings,
  enabledModes,
  isBrowserProfileSiteRemembered,
} from "@octant/domain";
import { prepareBrowserDownloadHoldRoot } from "@octant/host-runtime";
import { createBrowserDownloadJournal } from "../browser/browserDownloadJournal";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { ProvidersWiring } from "./providers";
import type { HarnessStateWiring } from "./harnessState";
import {
  BrowserSessionGrants,
  type CurrentBrowserSessionTarget,
} from "../browser/browserSessionGrants";
import {
  BrowserDelegatedChildren,
  currentManagedChildBrowserTarget,
} from "../browser/browserDelegatedChildren";
import { browserSessionGrantJournal } from "../browser/browserSessionGrantJournal";
import type { TerminalBrowserGrantId, ProviderExecutionPolicy } from "@octant/contracts";
import type { BrowserSessionGrantee } from "@octant/contracts/browser-session-grants";
import { decodeAgentRunId, type AgentRun } from "@octant/contracts";

export type BrowserDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "browserCaptures"
    | "machineChangeFeed"
    | "onWindowRevoked"
    | "windowAuthorityStore"
    | "codeSessionAuthority"
  > &
  Pick<AgentRunsWiring, "externalContentIngestionStore" | "contributeChildTools"> &
  Pick<HarnessStateWiring, "agentRunInteractions"> &
  Pick<WorkspaceWiring, "projectService" | "shellService"> &
  Pick<ProvidersWiring, "localPluginImportReceipts" | "providerDataDirectory"> &
  Pick<FoundationsWiring, "browserAuthority" | "codeEvidence" | "providerRuntimeRegistry">;

export function wireBrowser(deps: BrowserDependencies) {
  const {
    browserAuthority,
    providerRuntimeRegistry,
    contributeChildTools,
    agentRunInteractions,
    browserCaptures,
    codeSessionAuthority,
    codeEvidence,
    externalContentIngestionStore,
    localPluginImportReceipts,
    machineChangeFeed,
    onWindowRevoked,
    options,
    persistence,
    projectService,
    providerDataDirectory,
    shellService,
    windowAuthorityStore,
  } = deps;
  return Effect.gen(function* () {
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
    const rememberedProfileSites = () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .rememberedBrowserProfileSites;
    // The same journaled path as an origin grant, keyed by the pair so a site
    // remembered for one profile never covers another.
    const rememberBrowserProfileSite = (
      windowId: WindowId,
      origin: string,
      profile: StoredBrowserProfile,
    ) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stored = persistence.readShellSettings();
        const current = stored?.settings ?? defaultShellSettings();
        if (
          isBrowserProfileSiteRemembered(current.rememberedBrowserProfileSites, origin, profile)
        ) {
          return;
        }
        try {
          shellService.rememberBrowserProfileSites({
            windowId,
            expectedVersion: stored?.aggregateVersion ?? decodeAggregateVersion(0),
            sites: [{ origin, profile }],
          });
          return;
        } catch (error) {
          if (!(error instanceof ShellServiceError && error.failure.category === "conflict")) {
            console.warn(
              `Octant could not remember a signed-in site approval: ${
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
      rememberOrigin: (origin, windowId, profile) =>
        profile === undefined
          ? rememberBrowserOrigin(windowId, origin)
          : rememberBrowserProfileSite(windowId, origin, profile),
      // A remembered Private origin never covers a profile page, and a pair for
      // one profile never covers another, so each branch reads only its own set.
      isOriginRemembered: (origin, profile) =>
        profile === undefined
          ? rememberedBrowserOrigins().includes(origin)
          : isBrowserProfileSiteRemembered(rememberedProfileSites(), origin, profile),
      isHostScope: isRoutineHostScope,
      isLocalWindow: (windowId) => windowAuthorityStore.listWindowIds().includes(windowId),
      extensionsEnabledIn: (profile) => extensionFoldersFor(profile).length,
      profileLabel: async (profile) => {
        if (profile.kind !== "account") return undefined;
        const rows = await browserRuntime.profiles?.list(false);
        return rows?.find(
          (entry) =>
            entry.profile.kind === "account" &&
            String(entry.profile.profileId) === String(profile.profileId),
        )?.label;
      },
      onChanged: () => machineChangeFeed.publish(["tool-approvals"]),
    });
    onWindowRevoked((windowId) => browserToolApprovalService.revokeWindow(windowId));
    const headlessBrowserRuntime = createPlaywrightBrowserRuntime({
      receiptDirectory: join(providerDataDirectory, "browser", "runtime-receipts"),
    });
    // The extensions enabled in a profile, read from the journal when a page opens
    // there. The service is built after the runtime, so the runtime reads it late.
    let extensionFoldersFor: BrowserExtensionService["enabledFolders"] = () => [];
    const desktopBrowserRuntime = createDesktopBrowserRuntimeFromEnvironment(process.env, {
      extensionsFor: (profile) => extensionFoldersFor(profile),
    });
    const browserRuntime: BrowserRuntimePort =
      options.browserRuntime ??
      (desktopBrowserRuntime === undefined
        ? headlessBrowserRuntime
        : new RoutingBrowserRuntime({
            native: desktopBrowserRuntime,
            headless: headlessBrowserRuntime,
          }));
    const childSessionTarget = (run: AgentRun): CurrentBrowserSessionTarget | undefined =>
      currentManagedChildBrowserTarget(run, {
        canReview: (candidate) => agentRunInteractions.canReviewSession(candidate),
        resolveParent: (threadId, mode) => browserAuthority.resolve(threadId, mode),
        supportsTools: (providerInstanceId, modelId) => {
          const observed = providerRuntimeRegistry.observedState(providerInstanceId);
          return (
            observed?.capabilities.appManagedTools === "supported" ||
            observed?.verifiedToolModelIds?.some((id) => String(id) === String(modelId)) === true
          );
        },
      });
    const routineSessionTarget = (
      routineId: AutomationId,
    ): CurrentBrowserSessionTarget | undefined => {
      const definition = persistence.automationProjection.getDefinition(routineId);
      if (definition === undefined) return undefined;
      const provider = persistence.readProviderInstance(
        definition.executionProfile.providerInstanceId,
      );
      const observed = providerRuntimeRegistry.observedState(
        definition.executionProfile.providerInstanceId,
      );
      const profile = persistence.readAgentProfile(definition.executionProfile.profileId);
      const binding = definition.binding;
      const checkout =
        binding.kind === "code" ? persistence.readCodeCheckout(binding.checkoutId) : undefined;
      if (
        binding.kind === "code" &&
        (checkout?.availability !== "available" ||
          String(checkout.repositoryId) !== String(binding.repositoryId))
      )
        return undefined;
      return currentRoutineBrowserTarget({
        definition,
        project: persistence.readProject(definition.projectId),
        toolHostId: deriveToolHostId(persistence.dataDirectory),
        providerEligible:
          provider?.enabled === true &&
          (observed?.capabilities.appManagedTools === "supported" ||
            observed?.verifiedToolModelIds?.some(
              (id) => String(id) === String(definition.executionProfile.modelId),
            ) === true),
        executionProfileCurrent:
          profile !== undefined &&
          isToolAllowedByAllowlist(profile.toolConstraints, "octant_browser") &&
          profile.version === definition.executionProfile.profileVersion &&
          profile.defaultExecutionPolicy === definition.executionProfile.executionPolicy,
      });
    };
    let terminalSessionSource:
      | {
          readonly current: (
            grantId: TerminalBrowserGrantId,
          ) => CurrentBrowserSessionTarget | undefined;
          readonly targets: () => ReadonlyArray<CurrentBrowserSessionTarget>;
        }
      | undefined;
    const currentSessionTarget = (
      grantee: BrowserSessionGrantee,
    ): CurrentBrowserSessionTarget | undefined => {
      if (grantee.kind === "routine") return routineSessionTarget(grantee.routineId);
      if (grantee.kind === "terminal") return terminalSessionSource?.current(grantee.grantId);
      if (grantee.kind !== "child") return undefined;
      const run = persistence.agentRunProjection.getById(grantee.runId);
      return run === undefined ? undefined : childSessionTarget(run);
    };
    let delegatedChildren: BrowserDelegatedChildren | undefined;
    const browserSessionGrants = new BrowserSessionGrants({
      now: Date.now,
      uuid: randomUUID,
      isLocalWindow: (windowId) => windowAuthorityStore.listWindowIds().includes(windowId),
      localWindows: () => windowAuthorityStore.listWindowIds(),
      canReview: (windowId, target) => {
        if (target.grantee.kind === "routine" || target.grantee.kind === "terminal")
          return (
            target.authority.mode !== "chat" &&
            windowHoldsProject(windowId, target.authority.projectId, target.authority.mode)
          );
        if (target.grantee.kind !== "child") return false;
        const run = persistence.agentRunProjection.getById(target.grantee.runId);
        return (
          run !== undefined &&
          browserAuthority.canAccessWindow(
            windowId,
            decodeBrowserThreadId(String(run.parentThreadId)),
            target.authority.mode,
          )
        );
      },
      targets: () => [
        ...(terminalSessionSource?.targets() ?? []),
        ...persistence.automationProjection.listDefinitions().flatMap((definition) => {
          const row = routineSessionTarget(definition.id);
          return row === undefined ? [] : [row];
        }),
        ...persistence.agentRunProjection
          .listCenterCandidates({ status: "all", mode: "all" })
          .flatMap(({ run }) => {
            const target = childSessionTarget(run);
            return target === undefined ? [] : [target];
          }),
      ],
      current: currentSessionTarget,
      profileLabel: (profile) => browserProfileService.labelOfStoredProfile(profile),
      record: browserSessionGrantJournal({
        journal: persistence.journal,
        connection: persistence.connection,
        uuid: randomUUID,
        now: Date.now,
        personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      }),
      onRevoked: (grantId) => {
        void delegatedChildren?.revoke(grantId);
        machineChangeFeed.publish(["tool-approvals"]);
      },
    });
    delegatedChildren = new BrowserDelegatedChildren({
      runtime: browserRuntime,
      grants: browserSessionGrants,
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      uuid: randomUUID,
      now: Date.now,
    });
    const browserDelegatedChildren = delegatedChildren;
    const bindTerminalBrowserSessions = (source: NonNullable<typeof terminalSessionSource>) => {
      terminalSessionSource = source;
      return () => {
        if (terminalSessionSource === source) terminalSessionSource = undefined;
        browserSessionGrants.revalidate();
        void browserDelegatedChildren.settle();
      };
    };
    const terminalBrowserTools = (input: {
      readonly grantId: TerminalBrowserGrantId;
      readonly threadId: BrowserThreadId;
      readonly executionPolicy: ProviderExecutionPolicy;
    }) => {
      const initial = terminalSessionSource?.current(input.grantId);
      if (initial === undefined) return undefined;
      return browserDelegatedChildren.tools({
        target: initial.target,
        executionId: String(input.grantId),
        contentThreadId: input.threadId,
        executionPolicy: input.executionPolicy,
        current: () => {
          const row = terminalSessionSource?.current(input.grantId);
          return row?.revision === initial.revision ? row.target : undefined;
        },
      });
    };
    const routineBrowserTools = (input: {
      readonly routineRun: AutomationRunReference;
      readonly threadId: BrowserThreadId;
      readonly currentAuthority: () => ToolActionAuthority | undefined;
      readonly currentModelId: () => string | undefined;
    }) => {
      const initial = routineSessionTarget(input.routineRun.automationId);
      if (initial === undefined) return undefined;
      const current = () => {
        const definition = persistence.automationProjection.getDefinition(
          input.routineRun.automationId,
        );
        const target = routineSessionTarget(input.routineRun.automationId);
        if (String(input.currentModelId()) !== String(target?.target.modelId)) return undefined;
        return routineBrowserExecutionIsCurrent({
          run: persistence.automationProjection.getRun(input.routineRun.runId),
          definition,
          target,
          threadId: input.threadId,
          authority: input.currentAuthority(),
          codeExecution:
            definition?.mode === "code"
              ? (() => {
                  const thread = persistence.readCodeThread(
                    decodeCodeThreadId(String(input.threadId)),
                  );
                  return {
                    thread,
                    checkout:
                      thread === undefined
                        ? undefined
                        : persistence.readCodeCheckout(thread.checkoutId),
                  };
                })()
              : undefined,
        })
          ? target?.target
          : undefined;
      };
      return browserDelegatedChildren.tools({
        target: initial.target,
        executionAuthority: () => (current() === undefined ? undefined : input.currentAuthority()),
        executionId: String(input.routineRun.runId),
        contentThreadId: input.threadId,
        executionPolicy:
          persistence.automationProjection.getDefinition(input.routineRun.automationId)
            ?.executionProfile.executionPolicy ?? "plan",
        current,
      });
    };
    contributeChildTools(({ run, authority }) => {
      const target = childSessionTarget(run)?.target;
      if (target === undefined || !authority.tools) return undefined;
      return browserDelegatedChildren.tools({
        target,
        executionPolicy: authority.executionPolicy,
        current: () =>
          agentRunInteractions.isCurrent(run)
            ? currentSessionTarget({ kind: "child", runId: decodeAgentRunId(String(run.id)) })
                ?.target
            : undefined,
      });
    });
    const unsubscribeSessionAuthority = persistence.journal.subscribeCommitted((append) => {
      if (
        !append.events.some((event) =>
          [
            "terminal-browser-grant",
            "automation-definition",
            "automation-run",
            "project",
            "provider-instance",
            "agent-profile",
            "code-thread",
            "work-thread",
          ].includes(event.aggregateType),
        )
      )
        return;
      const settle = () => {
        browserSessionGrants.revalidate();
        void browserDelegatedChildren.settle();
      };
      // SQLite-backed task authority is current at commit. Inspect it now so
      // changing a model away and back cannot preserve the earlier permission.
      settle();
      // Automation/Work in-memory projections apply after the journal append.
      queueMicrotask(settle);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeSessionAuthority));
    onWindowRevoked((windowId) => {
      browserSessionGrants.revokeWindow(windowId);
      void browserDelegatedChildren.closeWindow(windowId);
    });
    yield* Effect.promise(() => browserRuntime.reconcile?.() ?? Promise.resolve());
    // A file an earlier run held for an agent has no page and no question left.
    yield* Effect.promise(() =>
      prepareBrowserDownloadHoldRoot("headless").then(
        () => undefined,
        (error: unknown) => {
          console.warn(
            `Octant could not clear the Browser's held downloads: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      ),
    );
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
    onWindowRevoked((windowId) => void projectBrowserService.revokeWindow(windowId));
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
      pageScriptPolicy: (windowId, threadId, mode) => {
        if (
          mode !== "code" ||
          isRoutineHostScope(windowId) ||
          !windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId))
        )
          return undefined;
        const thread = persistence.readCodeThread(decodeCodeThreadId(String(threadId)));
        return thread?.lifecycle === "active"
          ? codeSessionAuthority.effectiveThread(windowId, thread).executionPolicy
          : undefined;
      },
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
      isUnattendedScope: isRoutineHostScope,
      // The person's "Let agents download files" switch, read each time: it
      // lives in shell settings, which only a local window writes.
      agentDownloadsEnabled: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).agentBrowserDownloads,
      downloads: createBrowserDownloadJournal({
        journal: persistence.journal,
        connection: persistence.connection,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      now: Date.now,
    });
    onWindowRevoked((windowId) => void browserAutomationService.revokeWindow(windowId));
    const credentialMetadataBroker =
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeSecretStoreBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          });
    const credentialUseJournal = secretStoresJournal({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      now: () => new Date().toISOString(),
    });
    const browserCredentialUseService = createBrowserCredentialUseService({
      fill: {
        prepare: async (windowId, target) =>
          (await browserRuntime.prepareCredentialFill?.(
            target.contextId,
            { windowId, threadId: target.threadId },
            target.topOrigin,
          )) ?? { status: "refused", reason: "unavailable" },
        hold: (windowId, target, planId) =>
          browserAutomationService.holdCredentialFill(windowId, target, planId),
        host: async (command) =>
          (await credentialMetadataBroker?.browserFill?.(command)) ?? {
            status: "refused",
            reason: "unavailable",
          },
        cancel: async (windowId, target, planId) => {
          return browserRuntime.cancelCredentialFill?.(
            target.contextId,
            { windowId, threadId: target.threadId },
            planId,
          );
        },
        submit: async (windowId, target, planId, expiresAt) =>
          (await browserRuntime.submitCredentialFill?.(
            target.contextId,
            { windowId, threadId: target.threadId },
            planId,
            expiresAt,
          )) ?? { status: "failed", effect: "none" },
      },
      currentTarget: (windowId, command, held) =>
        browserAutomationService.credentialUseTarget(windowId, command, held),
      metadata: async (item) =>
        (await credentialMetadataBroker?.browserMetadata?.(item)) ?? { status: "unavailable" },
      record: (record) => credentialUseJournal.record(record),
      now: Date.now,
      uuid: randomUUID,
    });
    const browserExtensionService = new BrowserExtensionService({
      dataDirectory: persistence.dataDirectory,
      journal: persistence.journal,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      receipts: localPluginImportReceipts,
      runtime: browserRuntime,
      // Another browser's extensions are listed and copied only on the person's pick.
      importHome: homedir(),
      readProject: persistence.readProject,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      now: Date.now,
    });
    extensionFoldersFor = (profile) => browserExtensionService.enabledFolders(profile);
    // The profiles the desktop app stores, listed and cleared by the person.
    // Clearing closes the server's own records of the profile's pages first, then
    // asks the desktop app to remove the store.
    const browserProfileService = new BrowserProfileService({
      runtime: browserRuntime,
      readProject: persistence.readProject,
      journal: persistence.journal,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      closePages: async (profile) => {
        browserSessionGrants.invalidateProfile(profile);
        if (!browserCredentialUseService.invalidateProfile(profile))
          throw new Error("Profile login permission revocations could not be recorded.");
        await Promise.all([
          liveProjectBrowsers.closeProfile(profile),
          browserAutomationService.closeProfile(profile),
        ]);
      },
      // Another browser's cookies are read only on the person's pick, through
      // the platform's own Keychain prompt, and only on a Mac.
      cookieReader: createBrowserCookieReader({
        home: homedir(),
        readKeychainPassword: readKeychainPasswordWithSecurityTool,
        now: Date.now,
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // The Project's saved Browser flows and the recorder of each page's run.
    // Both live as long as the host, because a turn's tool set is rebuilt each
    // turn and the run it recorded must outlive it.
    const browserFlowService = new BrowserFlowService({
      journal: persistence.journal,
      connection: persistence.connection,
      readProject: persistence.readProject,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const browserFlows: BrowserFlowToolPort = {
      service: browserFlowService,
      recorder: new BrowserFlowRecorder(),
      caller: (windowId) =>
        browserToolApprovalService.isPairedDevice(windowId)
          ? "paired-device"
          : browserToolApprovalService.isUnattendedScope(windowId)
            ? "unattended"
            : "person",
    };
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
    const nativeBrowserPresentationRoutes = createNativeBrowserPresentationRoutes({
      store: windowAuthorityStore,
      runtime: browserRuntime,
      owns: (windowId, request) =>
        browserAutomationService.ownsHumanPresentation(
          windowId,
          request.contextId,
          request.threadId,
        ) ||
        projectBrowserService.ownsHumanPresentation(windowId, request.contextId, request.threadId),
      now: Date.now,
    });
    return {
      nativeBrowserPresentationRoutes,
      browserSessionGrants,
      routineBrowserTools,
      bindTerminalBrowserSessions,
      terminalBrowserTools,
      browserDelegatedChildren,
      browserAutomationService,
      browserCredentialUseService,
      browserExtensionService,
      browserFlowService,
      browserFlows,
      browserProfileService,
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
