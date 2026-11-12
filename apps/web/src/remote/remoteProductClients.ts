import {
  createConversationInputClient,
  type ConversationInputClient,
} from "@octant/client-runtime/conversation-input-client";
import {
  createDefaultDeviceKeyStore,
  createRemoteProductFetch,
  type RemoteSessionBridge,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import {
  createExtensionClient,
  type ExtensionClient,
} from "@octant/client-runtime/extension-client";
import { createChatClient, type ChatClient } from "@octant/client-runtime/chat-client";
import { createCanvasClient, type CanvasClient } from "@octant/client-runtime/canvas-client";
import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import { createProviderClient, type ProviderClient } from "@octant/client-runtime/provider-client";
import {
  createWorkMutationClient,
  type WorkMutationClient,
} from "@octant/client-runtime/work-mutation-client";
import {
  createWorkRequestClient,
  type WorkRequestClient,
} from "@octant/client-runtime/work-request-client";
import {
  createWorkThreadClient,
  type WorkThreadClient,
} from "@octant/client-runtime/work-thread-client";
import {
  createReplicaSyncStatusClient,
  type ReplicaSyncStatusClient,
} from "@octant/client-runtime/replica-sync-status-client";
import { createWorkTurnClient, type WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import {
  createReplyDetailClient,
  type ReplyDetailClient,
} from "@octant/client-runtime/reply-detail-client";
import { createBrowserHostRegistryStorage } from "../host/browserHostRegistryStorage";
import { browserOwnerMergeUnlock, createBrowserGuestStore } from "../host/browserHubGuest";
import { platformPasskeys } from "../host/ownerPasskey";

export interface RemoteProductClients {
  readonly conversationInputs?: ConversationInputClient;
  readonly chat: ChatClient;
  readonly canvas: CanvasClient;
  readonly code: CodeClient;
  readonly project: ProjectClient;
  readonly provider: ProviderClient;
  readonly workThread: WorkThreadClient;
  readonly workTurn: WorkTurnClient;
  readonly workMutation: WorkMutationClient;
  readonly workRequest: WorkRequestClient;
  /** Read-only sync status; setting up, joining, and revoking stay on the host. */
  readonly syncStatus: ReplicaSyncStatusClient;
  /** Read-only Reply detail; changing a level stays with a window on the host. */
  readonly replyDetail: ReplyDetailClient;
}

// The Work and Code clients refuse a non-loopback base URL because the window
// capability they normally attach must never leave the machine. Over the
// remote session no capability is attached and the connection owns the
// destination, so the base URL only shapes the path; see
// `createRemoteProductFetch`.
const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";
const NO_WINDOW_CAPABILITY = "";

/**
 * The extension client over the session: a thread's waiting tool prompts and
 * their answers for every paired browser, and what the host takes only from
 * its own person (remembering an answer, remembered approvals) when `session`
 * says this browser acts as that person. Built apart from the other clients
 * because the host's word on the session arrives after they exist.
 */
export function createRemoteExtensionClient(
  bridge: RemoteSessionBridge,
  session: RemoteSessionStanding,
): ExtensionClient {
  return createExtensionClient({
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge }),
    windowCapability: NO_WINDOW_CAPABILITY,
    session,
  });
}

/**
 * The ordinary product clients, carried over the paired device's
 * authenticated session. Nothing here knows about the desktop window.
 */
export function createRemoteProductClients(bridge: RemoteSessionBridge): RemoteProductClients {
  const port = {
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge }),
    windowCapability: NO_WINDOW_CAPABILITY,
  };
  const canvas = createCanvasClient(port);
  return {
    conversationInputs: createConversationInputClient(port),
    chat: createChatClient(port),
    // Reading a Canvas never grants a paired browser the host's export,
    // credential, editing or share-management authority.
    canvas: {
      inventory: canvas.inventory,
      get: canvas.get,
      history: canvas.history,
      threadReferenceCards: canvas.threadReferenceCards,
      ...(canvas.designAssets === undefined ? {} : { designAssets: canvas.designAssets }),
      ...(canvas.publicShares === undefined ? {} : { publicShares: canvas.publicShares }),
    },
    // A host may ask this paired browser's merge for an owner unlock first;
    // the browser gives it with its passkey if it is an owner of that host.
    code: createCodeClient({
      ...port,
      ownerMergeUnlock: browserOwnerMergeUnlock({
        store: createBrowserGuestStore(createBrowserHostRegistryStorage()),
        deviceKeyStore: createDefaultDeviceKeyStore(),
        credentials: platformPasskeys,
        pageOrigin: globalThis.location.origin,
      }),
    }),
    project: createProjectClient(port),
    provider: createProviderClient(port),
    workThread: createWorkThreadClient(port),
    workTurn: createWorkTurnClient(port),
    workMutation: createWorkMutationClient(port),
    workRequest: createWorkRequestClient(port),
    replyDetail: createReplyDetailClient(port),
    syncStatus: createReplicaSyncStatusClient(port),
  };
}
