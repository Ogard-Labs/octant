import { approvedWorkingFolderRoot } from "../approvedWorkingFolders";
import {
  resolveThreadWorkingDirectory,
  threadWorkingDirectoryCurrent,
} from "../threadWorkingDirectoryAuthority";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import { workThreadAccessOf } from "@octant/domain";
import { clampAgentRunSessionAuthority } from "../agentRun/agentRunSessionRuntime";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  decodeBrowserThreadId,
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { Effect, Schema } from "effect";
import {
  AggregateId,
  CorrelationId,
  EventId,
  EventName,
  decodeAggregateVersion,
  decodeUtcTimestamp,
  decodeLocalServerRequestId,
} from "@octant/contracts";
import { createDesktopPreviewService } from "../computerUse/desktopPreviewService";
import type { ComputerUseWiring } from "./computerUse";
import type { LanguageServerHostPlatform } from "@octant/domain";
import {
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER,
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT,
  bundledLanguageServerComponent,
  resolveBundledLanguageServerActivation,
} from "@octant/plugin-host/language-servers";
import { createCodeRouteHandler, MAX_CODE_FILE_BODY_SIZE } from "../codeRoutes";
import { createPairedMergeUnlockSlot } from "../hub/pairedMergeUnlock";
import { createCodeLanguageAgentTools } from "../code/codeLanguageAgentTools";
import { CodeDebugService } from "../code/codeDebugService";
import { DebugAdapterProcessPort } from "../code/debugAdapterProcess";
import { DebugConfigurationApprovalStore } from "../code/debugConfigurationApprovals";
import { createDebugSessionEgress } from "../code/debugSessionEgress";
import { DebugSessionRecords } from "../code/debugSessionRecords";
import { installedDebugAdapterComponents } from "../code/installedDebugAdapters";
import { CodeLanguageService, type CodeLanguageServerComponent } from "../code/codeLanguageService";
import { LanguageServerApprovalStore } from "../code/languageServerApprovals";
import { createLanguageServerEgress } from "../code/languageServerEgress";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { LanguageServerProcessPort } from "../code/languageServerProcess";
import { managedTargetPath } from "../code/managedWorktreeService";
import { installedLanguageServerComponents } from "../code/installedLanguageServers";
import { isExtensionCompatibilityCompatible } from "../extensions/packageInspector";
import { EXTENSION_AGGREGATE_TYPE } from "../persistence/extensionProjection";
import {
  createCodeCheckoutOpenRouteHandler,
  createCodeExternalEditorRouteHandler,
  isCodeCheckoutOpenTargetCurrent,
  isCodeExternalEditorTargetCurrent,
} from "../codeExternalEditorRoutes";
import { createCodeOperationApprovalRouteHandler } from "../codeOperationApprovalRoutes";
import { suggestProjectActions } from "../code/projectActionSuggestions";
import { ProjectTerminalService } from "../code/projectTerminalService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createLocalServerRouteHandler } from "../localServerRoutes";
import { createRemoteServerGrantLocalRouteHandler } from "../remoteServerGrantLocalRoutes";
import { RemoteServerGrantService } from "../remote/remoteServerGrantService";
import {
  createLiveLocalListenerHoldingProbe,
  createLiveLocalListenerPort,
} from "../localServers/localListenerPort";
import {
  createLiveLocalServerHealthProbe,
  createLiveLocalServerStopPort,
} from "../localServers/localServerHostPorts";
import { createCodeThreadLocalServerScopeResolver } from "../localServers/localServerScopeResolver";
import { createRunningServiceScopeResolver } from "../localServers/runningServiceScopeResolver";
import { LocalServerService } from "../localServers/localServerService";
import { defaultShellSettings, enabledModes, projectExtraFolderRoots } from "@octant/domain";
import { pathIsProjectConfined } from "./providers";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import { stableCodeFileId, type CodeWiring } from "./code";
import { withProjectExtraFolders } from "../code/codeProjectFolderRoot";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { HarnessStateWiring } from "./harnessState";
import { serverCodeCheckout, serverThreadOf } from "../serverProjects/serverProjectThreads";
import { createServerProjectActions } from "../serverProjects/serverProjectActions";
import { createServerWorkActionTask } from "../serverProjects/serverWorkProjectActions";
import { serverWorkBindingRevisionId } from "../serverProjects/serverWorkThreads";
import { serverTerminalLogin } from "../serverProjects/serverTerminal";
import {
  decodeServerProjectRemovedPayload,
  SERVER_PROJECTS_EVENT_NAMES,
} from "@octant/contracts/server-projects";
import type { FoundationsWiring } from "./foundations";
import type { IntegrationsWiring } from "./integrations";
import type { ProvidersWiring } from "./providers";
import { windowCanAccessWorkProject } from "../windowCodeProjectAccess";

export type CodeToolingDependencies = Pick<ServerStart, "options" | "persistence" | "version"> &
  Pick<ComputerUseWiring, "desktopLeases" | "installDesktopPreviewRequest"> &
  Pick<
    AuthorityWiring,
    "agentRunPersistence" | "codeSessionAuthority" | "windowAuthorityStore" | "onWindowRevoked"
  > &
  Pick<AgentRunsWiring, "managedWorktreeReceipts"> &
  Pick<WorkspaceWiring, "projectRootPort" | "projectService"> &
  Pick<
    CodeWiring,
    "canAccessCodeProject" | "codeFileWatch" | "codeWorkingDirectoryProbePath" | "roots"
  > &
  Pick<
    CodeRuntimeWiring,
    "codeOperationRuntime" | "contributeCodeTools" | "routeCodeService" | "terminalProcessPort"
  > &
  Pick<FoundationsWiring, "browserAuthority" | "workThreadProjection"> &
  Pick<HarnessStateWiring, "serverConnection" | "serverProjectStore"> &
  Pick<IntegrationsWiring, "toolEgressRules"> &
  Pick<
    ProvidersWiring,
    | "extensionLifecycleService"
    | "extensionPackageStore"
    | "worktreePreparation"
    | "childWorktreeSources"
    | "resolveChildWorktree"
  >;

export function wireCodeTooling(deps: CodeToolingDependencies) {
  const {
    browserAuthority,
    workThreadProjection,
    agentRunPersistence,
    canAccessCodeProject,
    serverConnection,
    serverProjectStore,
    codeFileWatch,
    codeOperationRuntime,
    worktreePreparation,
    childWorktreeSources,
    resolveChildWorktree,
    codeSessionAuthority,
    contributeCodeTools,
    codeWorkingDirectoryProbePath,
    extensionLifecycleService,
    extensionPackageStore,
    managedWorktreeReceipts,
    onWindowRevoked,
    options,
    persistence,
    projectRootPort,
    projectService,
    roots,
    routeCodeService,
    terminalProcessPort,
    toolEgressRules,
    version,
    windowAuthorityStore,
  } = deps;
  // A file in a Project's extra folder is named by absolute path and resolves
  // to that folder; language services and debug sessions treat it as a plain
  // folder with no checkout of its own.
  const resolveRootWithExtraFolders = withProjectExtraFolders({
    resolve: (scopeId, thread, checkout, relativePath) =>
      roots.resolve(scopeId, thread, checkout, relativePath),
    extraFolders: (thread) => {
      const project = persistence.readProject(thread.projectId);
      return project?.type === "code" ? projectExtraFolderRoots(project) : [];
    },
    probePath: codeWorkingDirectoryProbePath,
    fileId: stableCodeFileId,
    statIdentity: async (path) => {
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Project folder is unavailable.");
      }
      return { device: metadata.dev.toString(10), inode: metadata.ino.toString(10) };
    },
  });
  return Effect.gen(function* () {
    // A person's own shell at a Work or Code Project's root, with no thread.
    // It shares the Code runtime's terminals, so one receipt store, reconcile,
    // and shutdown cover it; the journal records its start and end.
    const sharedTerminals = codeOperationRuntime?.terminals;
    const serverActions = createServerProjectActions({
      store: serverProjectStore,
      connection: serverConnection,
      workTask: createServerWorkActionTask({
        store: serverProjectStore,
        readThread: (id) => workThreadProjection.read(id),
        workspace: (id) => persistence.readWindowWorkspace(id)?.workspace,
        isWindowLive: (id) =>
          windowAuthorityStore.listWindowIds().some((live) => String(live) === String(id)),
        workEnabled: () =>
          enabledModes(
            persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          ).includes("work"),
      }),
      task: async (windowId, projectId, requested) => {
        const view = await routeCodeService.read(windowId, requested.threadId);
        if (
          view === undefined ||
          view.thread.lifecycle !== "active" ||
          String(view.thread.projectId) !== String(projectId) ||
          String(view.checkout.id) !== String(requested.checkoutId) ||
          view.checkout.kind !== "remote-root" ||
          view.checkout.availability !== "available"
        )
          return undefined;
        const place = serverThreadOf(serverProjectStore, view.thread);
        if (place === undefined) return undefined;
        const authorityOf = (thread: typeof view.thread) =>
          JSON.stringify({
            executionPolicy: thread.executionPolicy,
            permissionPersistence: thread.permissionPersistence,
            provider: thread.providerInstanceId,
            model: thread.modelId,
            toolConstraints: thread.toolConstraints,
          });
        const authorityRevision = authorityOf(view.thread);
        return {
          threadId: view.thread.id,
          checkoutId: view.checkout.id,
          root: place.folder,
          executionPolicy: view.thread.executionPolicy,
          authorityRevision,
          current: () => {
            const fresh = persistence.readCodeThread(view.thread.id);
            const checkout = persistence.readCodeCheckout(view.checkout.id);
            const placed =
              fresh === undefined ? undefined : serverThreadOf(serverProjectStore, fresh);
            return (
              fresh !== undefined &&
              fresh.lifecycle === "active" &&
              checkout?.kind === "remote-root" &&
              checkout.availability === "available" &&
              placed?.folder === place.folder &&
              String(fresh.checkoutId) === String(view.checkout.id) &&
              canAccessCodeProject(windowId, projectId) &&
              authorityOf(codeSessionAuthority.effectiveThread(windowId, fresh)) ===
                authorityRevision
            );
          },
        };
      },
    });
    const projectTerminals =
      sharedTerminals === undefined
        ? undefined
        : new ProjectTerminalService({
            ...serverActions,
            terminals: sharedTerminals,
            worktreePreparation,
            childWorktreeSources,
            readProject: persistence.readProject,
            canAccessProject: (scopeId, projectId) => {
              const project = persistence.readProject(projectId);
              if (
                project?.type !== "work" &&
                serverProjectStore.workProject(String(projectId)) === undefined
              )
                return canAccessCodeProject(scopeId, projectId);
              // A Work window reaches the Work Project its own persisted
              // workspace binds, while it is live, as a Code window does.
              return (
                (project === undefined || project.lifecycle === "active") &&
                enabledModes(
                  persistence.readShellSettings()?.settings ?? defaultShellSettings(),
                ).includes("work") &&
                windowAuthorityStore.listWindowIds().some((id) => String(id) === String(scopeId)) &&
                windowCanAccessWorkProject({
                  workspace: persistence.readWindowWorkspace(scopeId)?.workspace,
                  projectId,
                })
              );
            },
            resolveRoot: async (project) => {
              try {
                const binding = await projectRootPort.validate(
                  project.type,
                  project.binding.canonicalRoot,
                );
                if (binding.canonicalRoot !== project.binding.canonicalRoot) return undefined;
                const details = await lstat(binding.canonicalRoot);
                return details.isDirectory() && !details.isSymbolicLink()
                  ? binding.canonicalRoot
                  : undefined;
              } catch {
                return undefined;
              }
            },
            resolveActionWorkThread: async (windowId, projectId, threadId) => {
              const thread = workThreadProjection.read(threadId);
              const project = persistence.readProject(projectId);
              if (
                thread === undefined ||
                project?.type !== "work" ||
                thread.projectId !== projectId ||
                thread.lifecycle !== "active" ||
                !windowCanAccessWorkProject({
                  workspace: persistence.readWindowWorkspace(windowId)?.workspace,
                  projectId,
                })
              )
                return undefined;
              const selected = approvedWorkingFolderRoot(project, thread.workingFolderId);
              if (selected === undefined) return undefined;
              const root = await resolveThreadWorkingDirectory(
                selected,
                thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
              );
              const physicalCurrent = threadWorkingDirectoryCurrent(selected, root);
              const current = () => {
                const latest = persistence.readProject(projectId);
                return (
                  physicalCurrent() &&
                  latest?.type === "work" &&
                  approvedWorkingFolderRoot(latest, thread.workingFolderId) === selected &&
                  JSON.stringify(workThreadProjection.read(threadId)) === JSON.stringify(thread) &&
                  windowCanAccessWorkProject({
                    workspace: persistence.readWindowWorkspace(windowId)?.workspace,
                    projectId,
                  })
                );
              };
              return {
                root,
                executionPolicy: workThreadAccessOf(thread.access).executionPolicy,
                current,
                active: current,
              };
            },
            resolveActionCheckout: async (windowId, projectId, requested, childRequestId) => {
              const view = await routeCodeService.read(windowId, requested.threadId);
              if (
                view === undefined ||
                String(view.thread.projectId) !== String(projectId) ||
                String(view.checkout.id) !== String(requested.checkoutId) ||
                view.checkout.availability !== "available" ||
                view.checkout.kind === "remote-root"
              )
                return undefined;
              const { thread, checkout } = view;
              const head = checkout.head.kind === "none" ? undefined : checkout.head.oid;
              if (requested.head !== undefined && requested.head !== head) return undefined;
              const rooted = await roots.resolve(
                windowId,
                thread,
                checkout,
                codeWorkingDirectoryProbePath,
              );
              if (rooted === undefined) return undefined;
              const active = () => {
                const fresh = persistence.readCodeThread(thread.id);
                const present = persistence.readCodeCheckout(checkout.id);
                return (
                  fresh !== undefined &&
                  present !== undefined &&
                  rooted.current?.() === true &&
                  fresh.lifecycle === "active" &&
                  String(fresh.bindingRevisionId) === String(thread.bindingRevisionId) &&
                  String(fresh.checkoutId) === String(checkout.id) &&
                  codeSessionAuthority.effectiveThread(windowId, fresh).executionPolicy ===
                    thread.executionPolicy &&
                  present.availability === "available" &&
                  present.head.kind === checkout.head.kind &&
                  (present.head.kind !== "branch" ||
                    (checkout.head.kind === "branch" && present.head.name === checkout.head.name))
                );
              };
              const current = () => {
                const present = persistence.readCodeCheckout(checkout.id);
                return (
                  active() &&
                  canAccessCodeProject(windowId, projectId) &&
                  present !== undefined &&
                  (present.head.kind === "none" || present.head.oid === head)
                );
              };
              if (childRequestId !== undefined) {
                const project = persistence.readProject(projectId);
                if (project?.type !== "code") return undefined;
                const receipt = await resolveChildWorktree({
                  parentThreadId: String(thread.id),
                  requestId: childRequestId,
                  repositoryId: String(thread.repositoryId),
                  repositoryRoot: project.binding.canonicalRoot,
                  parentCheckoutRoot: rooted.rootPath,
                });
                if (receipt === undefined || !current()) return undefined;
                const run = agentRunPersistence.getByRequestId(childRequestId);
                if (
                  run === undefined ||
                  String(run.parentThreadId) !== String(thread.id) ||
                  run.workspaceReceipt.kind !== "code-worktree" ||
                  run.workspaceReceipt.worktreeRoot !== receipt.canonicalWorktreePath
                )
                  return undefined;
                let preparationAuthority;
                try {
                  preparationAuthority = clampAgentRunSessionAuthority(run);
                } catch {
                  return undefined;
                }
                const childActive = () => {
                  const fresh = agentRunPersistence.getById(run.id);
                  return (
                    active() &&
                    fresh !== undefined &&
                    JSON.stringify(fresh.authority) === JSON.stringify(run.authority) &&
                    JSON.stringify(fresh.routingReceipt.executionResolution) ===
                      JSON.stringify(run.routingReceipt.executionResolution)
                  );
                };
                return {
                  root: receipt.canonicalWorktreePath,
                  receiptId: receipt.receiptId,
                  preparationThread: { threadId: receipt.threadId, checkoutId: receipt.checkoutId },
                  preparationAccess: {
                    commands: preparationAuthority.shell && preparationAuthority.filesystem,
                    network: preparationAuthority.network,
                  },
                  executionPolicy: preparationAuthority.executionPolicy,
                  current: () => current() && childActive(),
                  active: childActive,
                };
              }
              const project = persistence.readProject(projectId);
              const selectedRoot =
                project?.type === "code"
                  ? approvedWorkingFolderRoot(project, thread.workingFolderId, rooted.rootPath)
                  : undefined;
              if (selectedRoot === undefined) return undefined;
              const workingRoot =
                thread.workingFolderId === undefined
                  ? rooted.rootPath
                  : await resolveThreadWorkingDirectory(
                      selectedRoot,
                      thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
                    );
              const physicalCurrent = threadWorkingDirectoryCurrent(selectedRoot, workingRoot);
              const folderCurrent = () => {
                const latest = persistence.readProject(projectId);
                return (
                  physicalCurrent() &&
                  current() &&
                  latest?.type === "code" &&
                  approvedWorkingFolderRoot(latest, thread.workingFolderId, rooted.rootPath) ===
                    selectedRoot
                );
              };
              return {
                root: rooted.rootPath,
                workingRoot,
                ...(checkout.kind === "managed-worktree"
                  ? { receiptId: String(checkout.ownershipReceiptId) }
                  : {}),
                executionPolicy: thread.executionPolicy,
                ...(head === undefined ? {} : { head }),
                ...(checkout.head.kind === "branch"
                  ? { branch: checkout.head.name }
                  : head === undefined
                    ? {}
                    : { branch: `Detached at ${head.slice(0, 12)}` }),
                current: folderCurrent,
                active: () => active() && folderCurrent(),
              };
            },
            suggestActions: suggestProjectActions,
            serverProject: (projectId) => {
              const project = serverProjectStore.project(String(projectId));
              if (project === undefined) return undefined;
              const registered = serverProjectStore.serverOf(String(projectId));
              const bindingRevisionId =
                project.mode === "work"
                  ? serverWorkBindingRevisionId(project)
                  : serverCodeCheckout(project).bindingRevisionId;
              return {
                mode: project.mode ?? "code",
                bindingRevisionId,
                ...(project.mode === "work"
                  ? {
                      interactiveAllowed: project.developerTools?.enabled === true,
                      current: () => {
                        const fresh = serverProjectStore.workProject(String(projectId));
                        const freshServer = serverProjectStore.serverOf(String(projectId));
                        return (
                          fresh !== undefined &&
                          registered !== undefined &&
                          String(serverWorkBindingRevisionId(fresh)) ===
                            String(bindingRevisionId) &&
                          freshServer?.alias === registered.alias &&
                          freshServer.user === registered.user &&
                          freshServer.profile === registered.profile
                        );
                      },
                    }
                  : {}),
                // Read at each start, so a server removed from the registry refuses.
                login: () => {
                  const address = serverProjectStore.addressOf(String(projectId));
                  return address.kind === "address"
                    ? serverTerminalLogin(serverConnection, address.server, address.folder)
                    : undefined;
                },
              };
            },
            readRunning: persistence.readRunningProjectTerminals,
            journal: persistence.journal,
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
          });
    projectTerminals?.reconcile();
    // Closing a window revokes its in-memory authority without a journal
    // commit. Retire its owned server sessions at that boundary, before another call.
    onWindowRevoked(() => void projectTerminals?.settleAuthorities());
    const unsubscribeProjectTerminalAuthority = persistence.journal.subscribeCommitted((append) => {
      if (projectTerminals === undefined) return;
      for (const event of append.events) {
        if (event.aggregateType === "server-projects" || event.aggregateType === "shield-servers") {
          // These catalogs apply their records after append returns. Read the
          // committed state, rather than keeping a session against the old one.
          queueMicrotask(() => void projectTerminals.settleAuthorities().catch(() => undefined));
        }
        if (
          event.aggregateType === "code-thread" ||
          event.aggregateType === "code-checkout" ||
          event.aggregateType === "work-thread" ||
          event.aggregateType === "shell-settings" ||
          event.aggregateType === "window-workspace"
        )
          void projectTerminals.settleAuthorities();
        if (
          event.aggregateType === "project" &&
          (event.eventName === "project.lifecycle-changed@1" ||
            event.eventName === "project.binding-relinked@1")
        ) {
          void projectTerminals.settleProject(decodeProjectId(event.aggregateId));
        }
        // A removed server Project ends the shells logged in for it.
        if (event.eventName === SERVER_PROJECTS_EVENT_NAMES.removed) {
          void projectTerminals.revokeProject(
            decodeServerProjectRemovedPayload(event.payload).projectId,
          );
        }
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeProjectTerminalAuthority));
    // Language services: confined language servers started on demand for a
    // Code checkout (docs/design/language-services.md). The bundled
    // TypeScript server is on by default, Settings › Code turns it off, and
    // it reads as unavailable on an install that has no binary for this host.
    // A server a person installed serves only once it is reviewed and switched
    // on, and after the bundled one for a language both declare.
    const bundledLanguageServers = bundledLanguageServerComponents(
      resolveBundledTypeScriptServerBinary(),
      () => persistence.readCodeSettings()?.settings.bundledLanguageServer !== false,
    );
    const installedLanguageServers = installedLanguageServerComponents({
      snapshot: () => extensionLifecycleService.snapshot(),
      store: extensionPackageStore,
      compatible: (compatibility) =>
        isExtensionCompatibilityCompatible(compatibility, version, process.platform),
    });
    // A `repo-tooling` server needs a person's journaled approval for its
    // checkout or Project, and reaches the network only through its own
    // egress proxy under the Project's rules: loopback on macOS, a Unix
    // socket in a private directory on Linux. Other platforms run no
    // language server at all.
    const languageServerApprovals = new LanguageServerApprovalStore({
      journal: persistence.journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const languageServerEgressDirectory = join(
      persistence.dataDirectory,
      "code",
      "language-server-egress",
    );
    const languageServerEgressEndpoint =
      process.platform === "darwin"
        ? ({ kind: "loopback" } as const)
        : process.platform === "linux"
          ? ({ kind: "unix-socket", parentDirectory: languageServerEgressDirectory } as const)
          : undefined;
    if (languageServerEgressEndpoint?.kind === "unix-socket") {
      mkdirSync(languageServerEgressDirectory, { recursive: true, mode: 0o700 });
    }
    const languageServerProcesses = new LanguageServerProcessPort({
      receiptDirectory: join(persistence.dataDirectory, "code", "language-server-receipts"),
      ...(languageServerEgressEndpoint === undefined
        ? {}
        : {
            egress: createLanguageServerEgress({
              journal: persistence.journal,
              projectRules: (projectId) => toolEgressRules.projectRules(projectId),
              joinRecheck: (proxy) => toolEgressRules.joinRecheck(proxy),
              endpoint: languageServerEgressEndpoint,
              hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
              uuid: randomUUID,
              clock: () => new Date().toISOString(),
            }),
          }),
    });
    const languageService = new CodeLanguageService({
      authority: {
        readThread: persistence.readCodeThread,
        readThreads: persistence.readCodeThreads,
        readCheckout: persistence.readCodeCheckout,
        // Read for every proxy decision, so it cannot wait on a receipt file:
        // a managed worktree's folder is the one its receipt must name, which
        // derives from the repository root and the thread.
        readThreadFolder: (thread) => {
          const project = persistence.readProject(thread.projectId);
          const checkout = persistence.readCodeCheckout(thread.checkoutId);
          if (project?.type !== "code" || checkout === undefined) return undefined;
          const root = project.binding.canonicalRoot;
          return checkout.kind === "managed-worktree"
            ? managedTargetPath(root, String(thread.repositoryId), String(thread.id))
            : root;
        },
        canAccessProject: canAccessCodeProject,
        effectiveThread: (scopeId, thread) => codeSessionAuthority.effectiveThread(scopeId, thread),
        resolveRoot: resolveRootWithExtraFolders,
      },
      approvals: languageServerApprovals,
      threadTainted: (threadId) => toolEgressRules.threadTainted(String(threadId)),
      components: () => [...bundledLanguageServers("effective"), ...installedLanguageServers()],
      turnedOffComponents: () => bundledLanguageServers("turned-off"),
      processes: languageServerProcesses,
      platform: languageServerHostPlatform(process.platform),
      cacheRoot: join(persistence.dataDirectory, "code", "language-server-cache"),
      watcher: codeFileWatch,
    });
    // A previous run's servers are ended before this run starts any.
    yield* Effect.promise(() => languageServerProcesses.reconcile().catch(() => undefined));
    languageService.startSweeping();
    // An archived or completed thread, a checkout that went away, the Settings
    // switch turned off, or a server whose trust or switch was withdrawn stops
    // at once rather than at the next timed sweep.
    const unsubscribeLanguageServerAuthority = persistence.journal.subscribeCommitted((append) => {
      if (
        append.events.some(
          (event) =>
            event.aggregateType === "code-thread" ||
            event.aggregateType === "code-checkout" ||
            event.aggregateType === "code-settings" ||
            event.aggregateType === EXTENSION_AGGREGATE_TYPE,
        )
      ) {
        void languageService.sweep().catch(() => undefined);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeLanguageServerAuthority));
    yield* Effect.addFinalizer(() => Effect.promise(() => languageService.close()));
    // Debug sessions (docs/design/language-services.md, Debugger addendum):
    // adapters a person installed and reviewed, configurations a person at a
    // local window confirmed, and sessions only that person starts. Below Full
    // access a session's program reaches the network through its own proxy
    // under its thread's rules, the proxy harness commands use; a host with
    // no proxy refuses such a session.
    const debugConfigurationApprovals = new DebugConfigurationApprovalStore({
      journal: persistence.journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const debugSessionRecords = new DebugSessionRecords({
      journal: persistence.journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const debugEgressDirectory = join(persistence.dataDirectory, "code", "debug-egress");
    const debugEgressEndpoint =
      process.platform === "darwin"
        ? ({ kind: "loopback" } as const)
        : process.platform === "linux"
          ? ({ kind: "unix-socket", parentDirectory: debugEgressDirectory } as const)
          : undefined;
    if (debugEgressEndpoint?.kind === "unix-socket") {
      mkdirSync(debugEgressDirectory, { recursive: true, mode: 0o700 });
    }
    const debugProcesses = new DebugAdapterProcessPort({
      receiptDirectory: join(persistence.dataDirectory, "code", "debug-session-receipts"),
      ...(debugEgressEndpoint === undefined
        ? {}
        : {
            egress: createDebugSessionEgress({
              journal: persistence.journal,
              rules: toolEgressRules,
              endpoint: debugEgressEndpoint,
              hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
              uuid: randomUUID,
              clock: () => new Date().toISOString(),
            }),
          }),
    });
    const debugStateRoot = join(persistence.dataDirectory, "code", "debug-session-state");
    const debugService = new CodeDebugService({
      authority: {
        readThread: persistence.readCodeThread,
        readCheckout: persistence.readCodeCheckout,
        canAccessProject: canAccessCodeProject,
        effectiveThread: (scopeId, thread) => codeSessionAuthority.effectiveThread(scopeId, thread),
        resolveRoot: resolveRootWithExtraFolders,
      },
      approvals: debugConfigurationApprovals,
      adapters: installedDebugAdapterComponents({
        snapshot: () => extensionLifecycleService.snapshot(),
        store: extensionPackageStore,
        compatible: (compatibility) =>
          isExtensionCompatibilityCompatible(compatibility, version, process.platform),
      }),
      processes: {
        launch: (input) => debugProcesses.launch(input),
        proxies: debugProcesses.proxies,
      },
      records: debugSessionRecords,
      platform: languageServerHostPlatform(process.platform),
      stateRoot: debugStateRoot,
      uuid: randomUUID,
    });
    // A previous run's capsules are ended, and its open session records
    // closed, before this run starts any session.
    // A session's state folder is its program's HOME, removed when it ends;
    // one a crashed run left is removed before any session starts.
    yield* Effect.promise(() => debugProcesses.reconcile().catch(() => undefined));
    yield* Effect.promise(() =>
      rm(debugStateRoot, { recursive: true, force: true }).catch(() => undefined),
    );
    debugSessionRecords.endLeftOpen();
    debugService.startSweeping();
    // A thread archived, completed, or moved to Plan or across Full access, a
    // checkout gone, an adapter's package changed, or a confirmation the
    // journal no longer holds ends a session at once.
    const unsubscribeDebugAuthority = debugService.endOnAuthorityChanges(persistence.journal);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeDebugAuthority));
    yield* Effect.addFinalizer(() => Effect.promise(() => debugService.close()));
    // The same reads as one app-managed tool on each Code turn whose provider
    // carries them, Plan included (decision D5), where a server an agent may
    // start covers a file of the checkout. Each call is checked at the
    // tool-call choke point, then by the service on the turn's window.
    contributeCodeTools(({ windowId, thread, readThread, folders }) =>
      createCodeLanguageAgentTools({
        windowId,
        thread,
        readThread,
        folders,
        authority: () => browserAuthority.resolve(decodeBrowserThreadId(String(thread.id)), "code"),
        externalContentIngested: () =>
          readThreadExternalContentTaint(persistence.connection, String(thread.id))
            .externalContentIngested,
        language: languageService,
        uuid: randomUUID,
      }),
    );
    // The hub side is wired after this; it binds the owner unlock a paired
    // client's merge may need into this slot.
    const pairedMergeUnlockSlot = createPairedMergeUnlockSlot();
    const codeRoutes = createCodeRouteHandler({
      service: routeCodeService,
      pairedMergeUnlock: pairedMergeUnlockSlot.current,
      ...(projectTerminals === undefined ? {} : { projectTerminals }),
      language: languageService,
      debug: debugService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      maxFileBodySize: MAX_CODE_FILE_BODY_SIZE,
    });
    // Local servers. The scope resolver is what decides who may stop a
    // process, so it is bound to the same authoritative thread, checkout, and
    // root resolution the Code workspace already uses. The live observer verifies
    // terminal roots and their descendants; unknown processes remain leftovers.
    const ownedTerminalProcessRoots = async () =>
      (await terminalProcessPort?.ownedProcessRoots()) ?? new Set<number>();
    const localServerService = new LocalServerService({
      listeners: createLiveLocalListenerPort({ ownedProcessRoots: ownedTerminalProcessRoots }),
      health: createLiveLocalServerHealthProbe(),
      stopPort: createLiveLocalServerStopPort(),
      scopes: createCodeThreadLocalServerScopeResolver({
        projects: projectService,
        source: {
          readThread: (threadId) => persistence.readCodeThread(threadId),
          readCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
          resolveCheckoutRoot: async (windowId, thread, checkout) =>
            (await roots.resolve(windowId, thread, checkout, codeWorkingDirectoryProbePath))
              ?.rootPath,
          ownedPids: () => new Set<number>(),
        },
      }),
      hostScopes: createRunningServiceScopeResolver({
        projects: projectService,
        source: {
          readThreads: persistence.readCodeThreads,
          readCheckout: persistence.readCodeCheckout,
          // Only the ownership receipt the host wrote for this thread's own
          // worktree vouches for the folder; the same fields the Code file
          // root authority demands, without its Git observation, because this
          // only names where a listener came from and authorizes nothing.
          managedWorktreeRoot: async (thread, checkout, repositoryRoot) => {
            const receipt = await managedWorktreeReceipts.load(checkout.ownershipReceiptId);
            return receipt !== undefined &&
              receipt.state === "ready" &&
              receipt.receiptId === checkout.ownershipReceiptId &&
              receipt.threadId === thread.id &&
              receipt.checkoutId === checkout.id &&
              receipt.repositoryId === thread.repositoryId &&
              receipt.repositoryId === checkout.repositoryId &&
              receipt.canonicalRepositoryPath === repositoryRoot
              ? receipt.canonicalWorktreePath
              : undefined;
          },
          ownedPids: () => new Set<number>(),
        },
      }),
      // A server Octant stopped ends every grant to it at once; a grant
      // never forwards to whatever takes the port next.
      onStopped: (stopped) => {
        remoteServerGrants.closeServer(stopped);
        void desktopPreviews.serverStopped(stopped);
      },
    });
    const localServerRoutes = createLocalServerRouteHandler({
      service: localServerService,
      persistence,
      projects: projectService,
      windowAuthorityStore,
    });
    // Grants to open an Octant-owned dev server from a paired device. They live
    // in this host's memory, bound to a proxy session; the journal records each
    // opening and closing, and a starting host closes what a past run left open.
    const remoteServerGrants = new RemoteServerGrantService({
      observeTarget: (scopeId, source, signal) =>
        localServerService.observeGrantTarget(scopeId, source, {
          actor: "remote-client",
          ...(signal === undefined ? {} : { signal }),
        }),
      canOpenThread: async (scopeId, threadId) =>
        (await routeCodeService.read(scopeId, threadId)) !== undefined,
      readThread: persistence.readCodeThread,
      readOpenGrants: persistence.readOpenRemoteServerGrants,
      confirmEndpoint: createLiveLocalListenerHoldingProbe({
        ownedProcessRoots: ownedTerminalProcessRoots,
      }),
      isCodeEnabled: () =>
        enabledModes(persistence.readShellSettings()?.settings ?? defaultShellSettings()).includes(
          "code",
        ),
      journal: persistence.journal,
      hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const desktopPreviews = createDesktopPreviewService({
      lease: deps.desktopLeases.previewTarget,
      revision: (caller) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(caller.owner.threadId));
        return thread === undefined
          ? undefined
          : JSON.stringify([
              thread.projectId,
              thread.checkoutId,
              thread.bindingRevisionId,
              thread.lifecycle,
              thread.executionPolicy,
            ]);
      },
      observe: async (caller, port) => {
        const threadId = decodeCodeThreadId(caller.owner.threadId);
        const thread = persistence.readCodeThread(threadId);
        if (thread === undefined || caller.scopeId === undefined) return { status: "not-listed" };
        const windowId = decodeWindowId(caller.scopeId);
        const listed = await localServerService.execute(
          windowId,
          {
            kind: "list-local-servers",
            requestId: decodeLocalServerRequestId(randomUUID()),
            threadId,
            projectId: thread.projectId,
          },
          { actor: "local-user" },
        );
        if (listed.kind !== "local-servers-listed") return { status: "not-listed" };
        const matches = listed.snapshot.currentCheckout.filter((row) => row.port === port);
        const row = matches[0];
        if (matches.length !== 1 || row === undefined) return { status: "not-listed" };
        return localServerService.observeGrantTarget(
          windowId,
          {
            surface: "local-servers",
            threadId,
            projectId: thread.projectId,
            listenerId: row.listenerId,
          },
          { actor: "local-user" },
        );
      },
      audit: (kind, payload, caller) => {
        persistence.journal.append({
          aggregate: {
            aggregateType: "desktop-preview",
            aggregateId: Schema.decodeUnknownSync(AggregateId)(payload.grantId),
          },
          expectedVersion: decodeAggregateVersion(kind === "granted" ? 0 : 1),
          events: [
            {
              eventId: Schema.decodeUnknownSync(EventId)(randomUUID()),
              eventName: Schema.decodeUnknownSync(EventName)(`desktop.preview-${kind}@1`),
              eventVersion: 1,
              correlationId: Schema.decodeUnknownSync(CorrelationId)(randomUUID()),
              actor: caller.actor,
              occurredAt: decodeUtcTimestamp(new Date().toISOString()),
              payload,
            },
          ],
        });
      },
    });
    deps.installDesktopPreviewRequest(desktopPreviews.request);
    const previewSweep = setInterval(() => {
      void desktopPreviews.sweep();
    }, 250);
    previewSweep.unref();
    const stopPreviewCommits = persistence.journal.subscribeCommitted(() => {
      void desktopPreviews.sweep();
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(previewSweep);
        stopPreviewCommits();
        await desktopPreviews.close();
      }),
    );
    try {
      remoteServerGrants.reconcile();
    } catch {
      console.error("[remote-server-grants] Grants a past run left open could not be closed.");
    }
    const unsubscribeRemoteServerGrants = persistence.journal.subscribeCommitted((append) =>
      remoteServerGrants.observeCommitted(append),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeRemoteServerGrants();
        // Proxy sessions do not outlive this process, so neither does a grant.
        remoteServerGrants.closeAll("proxy-session-ended");
      }),
    );
    const remoteServerGrantLocalRoutes = createRemoteServerGrantLocalRouteHandler({
      grants: remoteServerGrants,
      windowAuthorityStore,
    });
    const codeOperationApprovalRoutes = createCodeOperationApprovalRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      prepare: async (windowId, request) =>
        await codeOperationRuntime?.prepareApproval(windowId, request),
      confirm: async (windowId, confirmation) =>
        await codeOperationRuntime?.confirmApproval(windowId, confirmation),
      cancel: (windowId, confirmation) =>
        codeOperationRuntime?.cancelApproval?.(windowId, confirmation),
    });
    const codeExternalEditorRoutes = createCodeExternalEditorRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      resolve: async (input) => {
        const editor = persistence.readCodeSettings()?.settings.externalEditor;
        if (editor === undefined) return undefined;
        const windowId = decodeWindowId(input.windowId);
        const thread = persistence.readCodeThread(decodeCodeThreadId(input.threadId));
        const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(input.checkoutId));
        const reference = persistence.readCodeFileReference(decodeCodeFileId(input.fileId));
        if (
          thread === undefined ||
          checkout === undefined ||
          reference === undefined ||
          !isCodeExternalEditorTargetCurrent({ thread, checkout, reference })
        ) {
          return undefined;
        }
        try {
          const relativePath = reference.relativePath;
          if (relativePath === undefined) return undefined;
          const root = await roots.resolve(windowId, thread, checkout, relativePath);
          if (root === undefined || root.fileId !== reference.id) return undefined;
          const file = await realpath(resolve(root.rootPath, relativePath));
          if (!pathIsProjectConfined(root.rootPath, file)) return undefined;
          return { file, editor };
        } catch {
          return undefined;
        }
      },
    });
    const codeCheckoutOpenRoutes = createCodeCheckoutOpenRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      resolve: async (input) => {
        const windowId = decodeWindowId(input.windowId);
        const thread = persistence.readCodeThread(decodeCodeThreadId(input.threadId));
        if (thread === undefined) return undefined;
        const checkout = persistence.readCodeCheckout(thread.checkoutId);
        if (checkout === undefined || !isCodeCheckoutOpenTargetCurrent({ thread, checkout })) {
          return undefined;
        }
        try {
          const rooted = await roots.resolve(
            windowId,
            thread,
            checkout,
            codeWorkingDirectoryProbePath,
          );
          if (rooted === undefined) return undefined;
          return { checkoutRoot: await realpath(rooted.rootPath) };
        } catch {
          return undefined;
        }
      },
    });
    return {
      codeCheckoutOpenRoutes,
      codeExternalEditorRoutes,
      codeOperationApprovalRoutes,
      codeRoutes,
      debugConfigurationApprovals,
      debugService,
      languageServerApprovals,
      localServerRoutes,
      pairedMergeUnlockSlot,
      projectTerminals,
      remoteServerGrantLocalRoutes,
      remoteServerGrants,
    };
  });
}

export type CodeToolingWiring = Effect.Effect.Success<ReturnType<typeof wireCodeTooling>>;

/**
 * The bundled TypeScript server's binary for this host, from the pinned
 * `typescript` package's per-platform native package. Absent when this
 * install has none, which reads as the component being unavailable.
 */
function resolveBundledTypeScriptServerBinary(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve(
      `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(manifest), "lib", "tsc");
    return existsSync(binary) ? realpathSync(binary) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bundled language servers in Code, read on every request so a component
 * that stops being effective stops contributing at once. `effective` lists
 * the ones that serve; `turned-off` lists the ones that would serve but for
 * the person's Settings › Code switch, which is the component's own desired
 * switch on the activation ladder rather than a second gate beside it.
 */
function bundledLanguageServerComponents(
  typeScriptBinary: string | undefined,
  switchedOn: () => boolean,
): (which: "effective" | "turned-off") => ReadonlyArray<CodeLanguageServerComponent> {
  const bundled = bundledLanguageServerComponent(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER);
  const servesWith = (componentDesired: boolean) =>
    resolveBundledLanguageServerActivation(BUNDLED_TYPESCRIPT_LANGUAGE_SERVER, "code", {
      unavailable: typeScriptBinary === undefined,
      componentDesired,
    }).kind === "effective";
  return (which) => {
    const on = switchedOn();
    const listed = which === "effective" ? servesWith(on) : !on && servesWith(true);
    if (
      !listed ||
      typeScriptBinary === undefined ||
      bundled.entryPoint !== BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT
    ) {
      return [];
    }
    const componentKey = `${bundled.manifest.extensionId}:${bundled.component.id}`;
    return [
      {
        componentKey,
        // The bundled server is `static`, which no approval covers.
        approvalKey: componentKey,
        languages: bundled.languageServer.languages,
        launchClass: bundled.languageServer.launchClass,
        executable: async () => typeScriptBinary,
        args: ["--lsp", "--stdio"],
        installRoot: dirname(typeScriptBinary),
        sourceLabel: "typescript",
      },
    ];
  };
}

function languageServerHostPlatform(platform: NodeJS.Platform): LanguageServerHostPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}
