import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { Effect } from "effect";
import { createCodeRouteHandler, MAX_CODE_FILE_BODY_SIZE } from "../codeRoutes";
import {
  createCodeCheckoutOpenRouteHandler,
  createCodeExternalEditorRouteHandler,
  isCodeCheckoutOpenTargetCurrent,
  isCodeExternalEditorTargetCurrent,
} from "../codeExternalEditorRoutes";
import { createCodeOperationApprovalRouteHandler } from "../codeOperationApprovalRoutes";
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
import { defaultShellSettings, enabledModes } from "@octant/domain";
import { pathIsProjectConfined } from "./providers";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { CodeRuntimeWiring } from "./codeRuntime";

export type CodeToolingDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "managedWorktreeReceipts"> &
  Pick<WorkspaceWiring, "projectRootPort" | "projectService"> &
  Pick<CodeWiring, "canAccessCodeProject" | "codeWorkingDirectoryProbePath" | "roots"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime" | "routeCodeService" | "terminalProcessPort">;

export function wireCodeTooling(deps: CodeToolingDependencies) {
  const {
    canAccessCodeProject,
    codeOperationRuntime,
    codeWorkingDirectoryProbePath,
    managedWorktreeReceipts,
    options,
    persistence,
    projectRootPort,
    projectService,
    roots,
    routeCodeService,
    terminalProcessPort,
    windowAuthorityStore,
  } = deps;
  return Effect.gen(function* () {
    // A person's own shell at a Code Project's root, with no thread. It
    // shares the Code runtime's terminals, so one receipt store, reconcile,
    // and shutdown cover it; the journal records its start and end.
    const sharedTerminals = codeOperationRuntime?.terminals;
    const projectTerminals =
      sharedTerminals === undefined
        ? undefined
        : new ProjectTerminalService({
            terminals: sharedTerminals,
            readProject: persistence.readProject,
            canAccessProject: canAccessCodeProject,
            resolveRoot: async (project) => {
              try {
                const binding = await projectRootPort.validate(
                  "code",
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
            readRunning: persistence.readRunningProjectTerminals,
            journal: persistence.journal,
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
          });
    projectTerminals?.reconcile();
    const unsubscribeProjectTerminalAuthority = persistence.journal.subscribeCommitted((append) => {
      if (projectTerminals === undefined) return;
      for (const event of append.events) {
        if (
          event.aggregateType === "project" &&
          (event.eventName === "project.lifecycle-changed@1" ||
            event.eventName === "project.binding-relinked@1")
        ) {
          void projectTerminals.settleProject(decodeProjectId(event.aggregateId));
        }
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeProjectTerminalAuthority));
    const codeRoutes = createCodeRouteHandler({
      service: routeCodeService,
      ...(projectTerminals === undefined ? {} : { projectTerminals }),
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
      onStopped: (stopped) => remoteServerGrants.closeServer(stopped),
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
      localServerRoutes,
      projectTerminals,
      remoteServerGrantLocalRoutes,
      remoteServerGrants,
    };
  });
}

export type CodeToolingWiring = Effect.Effect.Success<ReturnType<typeof wireCodeTooling>>;
