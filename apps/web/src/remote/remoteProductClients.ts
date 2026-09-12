import { createRemoteProductFetch, type RemoteSessionBridge } from "@octant/client-runtime";
import { createChatClient, type ChatClient } from "@octant/client-runtime/chat-client";
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
import { createWorkTurnClient, type WorkTurnClient } from "@octant/client-runtime/work-turn-client";

export interface RemoteProductClients {
  readonly chat: ChatClient;
  readonly code: CodeClient;
  readonly project: ProjectClient;
  readonly provider: ProviderClient;
  readonly workThread: WorkThreadClient;
  readonly workTurn: WorkTurnClient;
  readonly workMutation: WorkMutationClient;
  readonly workRequest: WorkRequestClient;
}

// The Work and Code clients refuse a non-loopback base URL because the window
// capability they normally attach must never leave the machine. Over the
// remote session no capability is attached and the connection owns the
// destination, so the base URL only shapes the path; see
// `createRemoteProductFetch`.
const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";
const NO_WINDOW_CAPABILITY = "";

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
  return {
    chat: createChatClient(port),
    code: createCodeClient(port),
    project: createProjectClient(port),
    provider: createProviderClient(port),
    workThread: createWorkThreadClient(port),
    workTurn: createWorkTurnClient(port),
    workMutation: createWorkMutationClient(port),
    workRequest: createWorkRequestClient(port),
  };
}
