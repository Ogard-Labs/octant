import { decodeAgentAccessCommand } from "@octant/contracts";
import { DESKTOP_IPC_CHANNELS as IPC_CHANNELS } from "./ipcChannels";

/** What a window asks of Settings › Agent access. */
export type AgentAccessWindowRequest =
  | { readonly kind: "list" }
  | { readonly kind: "command"; readonly command: unknown };

export interface AgentAccessAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface AgentAccessControlRuntime {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}

export class AgentAccessControlFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAccessControlFailure";
  }
}

const GRANTS_PATH = "/api/desktop/agent-access";
const COMMANDS_PATH = "/api/desktop/agent-access/commands";

/**
 * Sends one Settings › Agent access request to the host with the window's
 * capability and the desktop secret, which only main holds. A command the
 * contract does not describe is refused here, before the host sees it; a
 * refusal from the host is an answer with its status. Only a request that never
 * reached the host throws.
 */
export async function sendAgentAccessRequest(
  runtime: AgentAccessControlRuntime,
  request: unknown,
): Promise<AgentAccessAnswer> {
  let route: { readonly path: string; readonly body?: string };
  if (isRecord(request) && request.kind === "list") {
    route = { path: GRANTS_PATH };
  } else if (isRecord(request) && request.kind === "command") {
    try {
      route = {
        path: COMMANDS_PATH,
        body: JSON.stringify(decodeAgentAccessCommand(request.command)),
      };
    } catch {
      return {
        status: 400,
        body: {
          kind: "refused",
          reason: "invalid",
          message: "That agent access request is not valid.",
        },
      };
    }
  } else {
    return {
      status: 400,
      body: {
        kind: "refused",
        reason: "invalid",
        message: "That agent access request is not valid.",
      },
    };
  }
  let response: Response;
  try {
    response = await runtime.fetch(new URL(route.path, runtime.serverUrl), {
      method: route.body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        "x-octant-desktop-secret": runtime.desktopBridgeSecret,
        "x-octant-window-capability": runtime.windowCapability,
        ...(route.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(route.body === undefined ? {} : { body: route.body }),
    });
  } catch {
    throw new AgentAccessControlFailure("Octant agent access is unavailable.");
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export function installAgentAccessIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly runtimeFor: (event: unknown) => AgentAccessControlRuntime;
}): void {
  options.handle(IPC_CHANNELS.agentAccessRequest, async (event, request) => {
    let runtime: AgentAccessControlRuntime;
    try {
      runtime = options.runtimeFor(event);
    } catch {
      throw new Error("Octant rejected an unauthorized agent access request.");
    }
    try {
      return await sendAgentAccessRequest(runtime, request);
    } catch (error) {
      throw new Error(
        error instanceof AgentAccessControlFailure
          ? error.message
          : "Octant agent access is unavailable.",
      );
    }
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
