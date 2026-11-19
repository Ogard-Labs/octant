import { createRemoteProductFetch, type RemoteSessionBridge } from "@octant/client-runtime";
import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import { createProviderClient, type ProviderClient } from "@octant/client-runtime/provider-client";

export interface PairedComputerCodeClients {
  readonly code: CodeClient;
  readonly project: ProjectClient;
  readonly provider: ProviderClient;
}

// The remote session owns the destination, so the base URL only shapes the
// path, and no window capability leaves this computer.
const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";
const NO_WINDOW_CAPABILITY = "";

/**
 * The clients a desktop window uses to start and follow Code threads on a
 * computer it paired, carried over that computer's session. In the desktop
 * window that session reaches the computer through Electron main's bounded
 * request channel, which cannot hold a read open, so thread events are read
 * without waiting.
 */
export function createPairedComputerCodeClients(
  bridge: RemoteSessionBridge,
): PairedComputerCodeClients {
  const port = {
    baseUrl: REMOTE_CLIENT_BASE_URL,
    fetch: createRemoteProductFetch({ bridge }),
    windowCapability: NO_WINDOW_CAPABILITY,
  };
  return {
    code: createCodeClient({ ...port, threadEvents: "poll" }),
    project: createProjectClient(port),
    provider: createProviderClient(port),
  };
}
