import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
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
import { Effect } from "effect";
import type { LanguageServerHostPlatform } from "@octant/domain";
import {
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER,
  BUNDLED_TYPESCRIPT_LANGUAGE_SERVER_ENTRY_POINT,
  bundledLanguageServerComponent,
  resolveBundledLanguageServerActivation,
} from "@octant/plugin-host/language-servers";
import { createCodeRouteHandler, MAX_CODE_FILE_BODY_SIZE } from "../codeRoutes";
import { createCodeLanguageAgentTools } from "../code/codeLanguageAgentTools";
import { CodeLanguageService, type CodeLanguageServerComponent } from "../code/codeLanguageService";
import { LanguageServerApprovalStore } from "../code/languageServerApprovals";
import { createLanguageServerEgress } from "../code/languageServerEgress";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { LanguageServerProcessPort } from "../code/languageServerProcess";
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
import type { FoundationsWiring } from "./foundations";
import type { IntegrationsWiring } from "./integrations";
import type { ProvidersWiring } from "./providers";

export type CodeToolingDependencies = Pick<ServerStart, "options" | "persistence" | "version"> &
  Pick<AuthorityWiring, "codeSessionAuthority" | "windowAuthorityStore"> &
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
  Pick<FoundationsWiring, "browserAuthority"> &
  Pick<IntegrationsWiring, "toolEgressRules"> &
  Pick<ProvidersWiring, "extensionLifecycleService" | "extensionPackageStore">;

export function wireCodeTooling(deps: CodeToolingDependencies) {
  const {
    browserAuthority,
    canAccessCodeProject,
    codeFileWatch,
    codeOperationRuntime,
    codeSessionAuthority,
    contributeCodeTools,
    codeWorkingDirectoryProbePath,
    extensionLifecycleService,
    extensionPackageStore,
    managedWorktreeReceipts,
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
        canAccessProject: canAccessCodeProject,
        effectiveThread: (scopeId, thread) => codeSessionAuthority.effectiveThread(scopeId, thread),
        resolveRoot: (scopeId, thread, checkout, relativePath) =>
          roots.resolve(scopeId, thread, checkout, relativePath),
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
    // The same reads as app-managed tools on each Code turn whose provider
    // carries them, Plan included (decision D5). Each call is checked at the
    // tool-call choke point, then by the service on the turn's window.
    contributeCodeTools(({ windowId, thread, readThread }) =>
      createCodeLanguageAgentTools({
        windowId,
        thread,
        readThread,
        authority: () => browserAuthority.resolve(decodeBrowserThreadId(String(thread.id)), "code"),
        externalContentIngested: () =>
          readThreadExternalContentTaint(persistence.connection, String(thread.id))
            .externalContentIngested,
        language: languageService,
        uuid: randomUUID,
      }),
    );
    const codeRoutes = createCodeRouteHandler({
      service: routeCodeService,
      ...(projectTerminals === undefined ? {} : { projectTerminals }),
      language: languageService,
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
      languageServerApprovals,
      localServerRoutes,
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
