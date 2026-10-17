import { randomUUID } from "node:crypto";
import { assistantTranscript } from "../chat/assistantTranscript";
import { createWorkTurnRouteHandler } from "../workTurnRoutes";
import { createNavigatorAssistantRouteHandler } from "../navigatorAssistant/navigatorAssistantRoutes";
import { NavigatorAssistantService } from "../navigatorAssistant/navigatorAssistantService";
import { readCanvasForWindow, resolveCanvasActiveContext } from "../canvasRoutes";
import { createZenRouteHandler } from "../zenRoutes";
import { createZenBackgroundRouteHandler } from "../zenBackgroundRoutes";
import { ZenFocusZoneStore } from "../zen/zenFocusZoneStore";
import { ZenService } from "../zen/zenService";
import { ZenBackgroundStore } from "../zen/zenBackgroundStore";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain";
import { ZenThreadCatalog } from "../zen/zenThreadCatalog";
import { localHostDisplayName } from "../localHostDisplayName";
import { ZenAssistantTools } from "../zen/zenAssistantTools";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { UsageWiring } from "./usage";
import type { WorkspaceWiring } from "./workspace";
import type { ProvidersWiring } from "./providers";
import type { BrowserWiring } from "./browser";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { CodeToolingWiring } from "./codeTooling";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";

export type ZenDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<UsageWiring, "zenEventStore"> &
  Pick<WorkspaceWiring, "projectService" | "shellService"> &
  Pick<ProvidersWiring, "providerDataDirectory"> &
  Pick<BrowserWiring, "windowHoldsProject"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime"> &
  Pick<CodeToolingWiring, "projectTerminals"> &
  Pick<ChatWiring, "chatService" | "contributeChatTools" | "navigatorAssistantBindings"> &
  Pick<WorkWiring, "workTurnService"> &
  Pick<FoundationsWiring, "providerRuntimeRegistry" | "workThreadProjection">;

export function wireZen(deps: ZenDependencies) {
  const {
    chatService,
    codeOperationRuntime,
    contributeChatTools,
    navigatorAssistantBindings,
    persistence,
    projectService,
    projectTerminals,
    providerDataDirectory,
    providerRuntimeRegistry,
    shellService,
    windowAuthorityStore,
    windowHoldsProject,
    workThreadProjection,
    workTurnService,
    zenEventStore,
  } = deps;

  const zenThreadCatalog = new ZenThreadCatalog({
    localHostId: LOCAL_HOST_ID,
    localHostDisplayName: localHostDisplayName(),
    readSettings: () => persistence.readShellSettings()?.settings ?? defaultShellSettings(),
    readProjects: (windowId) => projectService.bootstrap(windowId),
    readChatThreads: () => persistence.readChatThreads(),
    readWorkThreads: () => workThreadProjection.list(),
    readCodeThreads: () => persistence.readCodeThreads(),
    readCodeCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
  });
  const zenFocusZones = new ZenFocusZoneStore({
    journal: persistence.journal,
    uuid: randomUUID,
  });
  const zenService = new ZenService({
    loadSpace: (spaceId) => persistence.readZenSpace(spaceId),
    loadSpaceByWindow: (windowId) => persistence.readZenSpaceByWindowId(windowId),
    focusZone: {
      read: (windowId) => zenFocusZones.read(windowId),
      write: (zone) => zenFocusZones.write(zone),
    },
    // Pinning a terminal asks Code whether this window owns it. Without the
    // Code runtime there is nothing to own a shell, so there is nothing to
    // pin and Zen refuses rather than inventing an answer.
    ...(codeOperationRuntime === undefined
      ? {}
      : {
          codeTerminals: {
            read: (windowId, request) => codeOperationRuntime.inspectTerminal(windowId, request),
          },
        }),
    // Docking a Project's browser asks the same question its owner asks
    // before opening a page: does this window hold that Work or Code Project.
    projectBrowsers: {
      resolve: (windowId, projectId) => {
        const project = persistence.readProject(projectId);
        if (project === undefined || project.type === "chat" || project.lifecycle !== "active") {
          return undefined;
        }
        return windowHoldsProject(windowId, projectId, project.type)
          ? { mode: project.type }
          : undefined;
      },
    },
    ...(projectTerminals === undefined
      ? {}
      : {
          projectTerminals: {
            read: (windowId, projectId, terminalId) => {
              if (!projectTerminals.owns(windowId, projectId, terminalId)) return undefined;
              const project = persistence.readProject(projectId);
              return project === undefined ? undefined : { title: project.name };
            },
          },
        }),
    // Pinning a canvas asks Canvas whether this window may read it, the same
    // question the read route asks, so a card and a tab agree about what is
    // reachable instead of each keeping an answer of its own.
    canvases: {
      read: (windowId, canvasId) =>
        readCanvasForWindow(
          {
            canvasProjection: persistence.canvasProjection,
            projects: projectService,
            activeContextResolver: (id) => resolveCanvasActiveContext(shellService.bootstrap(id)),
          },
          windowId,
          canvasId,
        ),
    },
    eventStore: zenEventStore,
    localHostId: LOCAL_HOST_ID,
    threadCatalog: zenThreadCatalog,
    uuid: randomUUID,
    assistantChat: {
      // Zen's assistant is a front on the host's one Navigator conversation,
      // not a conversation of its own. Binding the id the host already owns
      // is what keeps the thread the user converses with and the thread Zen's
      // tools are authorized against the same thread. Resolved lazily because
      // Navigator is composed below.
      create: async () => {
        const threadId = await navigatorAssistantService.ensureConversation();
        try {
          return chatService.read(threadId).thread;
        } catch {
          throw new Error("Navigator conversation is unavailable.");
        }
      },
      read: (threadId) => {
        try {
          return chatService.read(threadId);
        } catch {
          return undefined;
        }
      },
    },
    assistantProviderState: (thread) => {
      const instance = persistence.readProviderInstance(thread.providerInstanceId);
      const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
      const model = observed?.models.find(
        (candidate) => String(candidate.id) === String(thread.modelId),
      );
      const verifiedForModel =
        observed?.verifiedToolModelIds?.some(
          (candidate) => String(candidate) === String(thread.modelId),
        ) ?? false;
      const toolCapability =
        observed?.capabilities.appManagedTools === "supported" || verifiedForModel
          ? "supported"
          : (observed?.capabilities.appManagedTools ?? "unavailable");
      return {
        providerInstanceId: thread.providerInstanceId,
        providerLabel: instance?.displayName ?? String(thread.providerInstanceId),
        modelId: thread.modelId,
        modelLabel: model?.displayName ?? String(thread.modelId),
        readiness: observed?.readiness ?? "unavailable",
        toolCapability,
        ...(toolCapability === "supported"
          ? {}
          : {
              toolCapabilityReason:
                toolCapability === "unsupported"
                  ? "This provider/model does not support app-managed tools. Use the manual Zen controls."
                  : "Tool capability has not been verified. Use the manual Zen controls.",
            }),
      };
    },
  });
  const zenAssistantTools = new ZenAssistantTools({ zenService });
  contributeChatTools((windowId, thread) => zenAssistantTools.forThread(windowId, thread));
  const zenRoutes = createZenRouteHandler({ zenService, windowAuthorityStore });
  // Navigator is the production consumer of the `navigatorAssistant`
  // settings section: the conversation runs on the configured default model
  // through the ordinary Chat commands below, and reports itself
  // unconfigured — never silently re-routed — when no default model is set.
  const navigatorAssistantService = new NavigatorAssistantService({
    localHostId: LOCAL_HOST_ID,
    readSettings: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings()).navigatorAssistant,
    bindings: navigatorAssistantBindings,
    chat: {
      create: async ({ threadId, title }) => {
        const result = await chatService.execute({
          kind: "create-chat-thread",
          hostId: LOCAL_HOST_ID,
          threadId,
          title,
        });
        if (result.kind !== "thread-created") {
          throw new Error("Navigator conversation creation failed.");
        }
      },
      read: (threadId) => {
        try {
          const view = chatService.read(threadId);
          return {
            threadId: view.thread.id,
            version: view.thread.version,
            lifecycle: view.thread.lifecycle,
            providerInstanceId: view.thread.providerInstanceId,
            modelId: view.thread.modelId,
            // The same fold Zen's assistant reads, so the Navigator dock
            // panel and Zen's assistant show one conversation, not two
            // readings of it.
            transcript: assistantTranscript(view),
          };
        } catch {
          return undefined;
        }
      },
      selectModel: async ({ threadId, expectedVersion, providerInstanceId, modelId }) => {
        await chatService.execute({
          kind: "change-chat-provider",
          threadId,
          expectedVersion,
          providerInstanceId,
          modelId,
        });
      },
      send: async ({ threadId, expectedVersion, prompt, windowId }) => {
        await chatService.execute(
          { kind: "send-chat-turn", threadId, expectedVersion, prompt },
          { windowId },
        );
      },
    },
    // Image capability comes from the host's observed provider catalog, the
    // same facts Settings renders; an unobserved model stays `unknown`.
    modelFacts: ({ providerInstanceId, modelId }) =>
      providerRuntimeRegistry
        .observedState(providerInstanceId)
        ?.models.find((candidate) => String(candidate.id) === String(modelId)),
    clock: () => new Date().toISOString(),
  });
  const navigatorAssistantRoutes = createNavigatorAssistantRouteHandler({
    service: navigatorAssistantService,
    windowAuthorityStore,
    // Navigator is host-owned, so there is no thread or Project target to
    // authorize; what must be proven is that the authenticated window is a
    // live workspace of this host. A capability whose window the host no
    // longer tracks cannot open the conversation or spend a provider turn.
    // Fresh local-session browsers mint a new window id and POST bootstrap
    // with workspaceVersion 0, so the durable projection is empty until a
    // later layout command. Treating that empty row as 403 refused every
    // first renderer connect after launch even though the window was live.
    authorizeWindow: ({ windowId }) => shellService.hasLiveWindow(windowId),
  });
  const zenBackgroundRoutes = createZenBackgroundRouteHandler({
    store: new ZenBackgroundStore({ dataDirectory: providerDataDirectory }),
    zenService,
    windowAuthorityStore,
    liveAssets: () =>
      new Map(
        persistence.readZenSpaces().flatMap((space) => {
          if (space.appearance.background.kind !== "image") return [];
          const owner = { ownerWindowId: space.windowId, spaceId: space.spaceId };
          return [
            [String(space.appearance.background.assetId), owner] as const,
            ...(space.appearance.background.stillAssetId === undefined
              ? []
              : [[String(space.appearance.background.stillAssetId), owner] as const]),
          ];
        }),
      ),
  });
  const workTurnRoutes = createWorkTurnRouteHandler({
    service: workTurnService,
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  return { navigatorAssistantRoutes, workTurnRoutes, zenBackgroundRoutes, zenRoutes, zenService };
}

export type ZenWiring = ReturnType<typeof wireZen>;
