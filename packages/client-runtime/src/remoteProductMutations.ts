import { RemoteConnectionError } from "./remoteConnection";
import type { RemoteSessionBridge } from "./remoteSessionBridge";
import { canExecuteRemoteProductMutation } from "./remoteShellHealth";
import {
  decodeChatBootstrap,
  decodeCodeBootstrap,
  decodeWorkThreadBootstrap,
} from "@octant/contracts";

export type RemoteProductSurface = "chat" | "work" | "code" | "preview" | "provider" | "settings";

export class RemoteProductMutationFailure extends Error {
  readonly surface: RemoteProductSurface;
  readonly category: "offline" | "rejected" | "unavailable";

  constructor(
    surface: RemoteProductSurface,
    category: "offline" | "rejected" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RemoteProductMutationFailure";
    this.surface = surface;
    this.category = category;
  }
}

function guardMutation(
  bridge: RemoteSessionBridge,
  surface: RemoteProductSurface,
): NonNullable<ReturnType<RemoteSessionBridge["connection"]>> {
  const state = bridge.getState();
  if (!canExecuteRemoteProductMutation(state)) {
    throw new RemoteProductMutationFailure(
      surface,
      "offline",
      "Octant is disconnected. Reconnect before sending changes.",
    );
  }
  const connection = bridge.connection();
  if (connection === undefined || connection.session() === undefined) {
    throw new RemoteProductMutationFailure(
      surface,
      "offline",
      "No authenticated remote session is available.",
    );
  }
  return connection;
}

async function assertRemoteResponse(
  surface: RemoteProductSurface,
  response: Response,
  failureMessage: string,
): Promise<{ readonly ok: true }> {
  if (!response.ok) {
    throw new RemoteProductMutationFailure(
      surface,
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  return { ok: true };
}

async function decodeRemoteResponse<T>(input: {
  readonly surface: RemoteProductSurface;
  readonly response: Response;
  readonly failureMessage: string;
  readonly decode: (value: unknown) => T;
}): Promise<T> {
  await assertRemoteResponse(input.surface, input.response, input.failureMessage);
  try {
    return input.decode(await input.response.json());
  } catch {
    throw new RemoteProductMutationFailure(
      input.surface,
      "unavailable",
      `${input.failureMessage} The host returned an invalid response.`,
    );
  }
}

/** Mode-valid Chat read via authenticated remote transport (project.overview.read). */
export async function exerciseRemoteChatSurface(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "chat");
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/chat/bootstrap",
  });
  return assertRemoteResponse("chat", response, "Chat bootstrap failed over the remote session.");
}

/** Strict Chat mutation via authenticated remote transport. */
export async function exerciseRemoteChatMutation(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "chat");
  const bootstrap = await decodeRemoteResponse({
    surface: "chat",
    response: await connection.authenticatedFetch({
      method: "GET",
      path: "/api/chat/bootstrap",
    }),
    failureMessage: "Chat bootstrap failed over the remote session.",
    decode: decodeChatBootstrap,
  });
  const settings = bootstrap.settings;
  const response = await connection.authenticatedFetch({
    method: "POST",
    path: "/api/chat/commands",
    body: JSON.stringify({
      kind: "update-chat-settings",
      expectedVersion: settings.version,
      ...(settings.defaultProviderInstanceId === undefined
        ? {}
        : { defaultProviderInstanceId: settings.defaultProviderInstanceId }),
      ...(settings.defaultModelId === undefined ? {} : { defaultModelId: settings.defaultModelId }),
      defaultResearchEnabled: settings.defaultResearchEnabled,
      defaultResearchRouting: settings.defaultResearchRouting,
      ...(settings.searxngBaseUrl === undefined ? {} : { searxngBaseUrl: settings.searxngBaseUrl }),
      defaultPersonalityInstructions: settings.defaultPersonalityInstructions,
    }),
  });
  return assertRemoteResponse("chat", response, "Chat mutation failed over the remote session.");
}

/** Mode-valid Work read via authenticated remote transport. */
export async function exerciseRemoteWorkSurface(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "work");
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/work/threads/bootstrap",
  });
  return assertRemoteResponse(
    "work",
    response,
    "Work thread inventory failed over the remote session.",
  );
}

/** Strict Work thread mutation via authenticated remote transport. */
export async function exerciseRemoteWorkMutation(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "work");
  const bootstrap = await decodeRemoteResponse({
    surface: "work",
    response: await connection.authenticatedFetch({
      method: "GET",
      path: "/api/work/threads/bootstrap",
    }),
    failureMessage: "Work thread inventory failed over the remote session.",
    decode: decodeWorkThreadBootstrap,
  });
  const thread = bootstrap.threads.find((candidate) => candidate.lifecycle === "active");
  if (thread === undefined) {
    throw new RemoteProductMutationFailure(
      "work",
      "unavailable",
      "Create a Work thread before exercising a remote Work mutation.",
    );
  }
  const response = await connection.authenticatedFetch({
    method: "POST",
    path: "/api/work/threads/commands",
    body: JSON.stringify({
      kind: "rename-work-thread",
      threadId: thread.id,
      expectedVersion: thread.version,
      title: thread.title,
    }),
  });
  return assertRemoteResponse("work", response, "Work mutation failed over the remote session.");
}

/** Mode-valid Code read via authenticated remote transport. */
export async function exerciseRemoteCodeSurface(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "code");
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/code/bootstrap",
  });
  return assertRemoteResponse("code", response, "Code bootstrap failed over the remote session.");
}

/** Strict Code mutation via authenticated remote transport. */
export async function exerciseRemoteCodeMutation(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "code");
  const bootstrap = await decodeRemoteResponse({
    surface: "code",
    response: await connection.authenticatedFetch({
      method: "GET",
      path: "/api/code/bootstrap",
    }),
    failureMessage: "Code bootstrap failed over the remote session.",
    decode: decodeCodeBootstrap,
  });
  const settings = bootstrap.settings;
  const response = await connection.authenticatedFetch({
    method: "POST",
    path: "/api/code/commands",
    body: JSON.stringify({
      kind: "update-code-settings",
      expectedVersion: settings.version,
      defaultExecutionPolicy: settings.defaultExecutionPolicy,
      defaultPermissionPersistence: settings.defaultPermissionPersistence,
      ...(settings.externalEditor === undefined ? {} : { externalEditor: settings.externalEditor }),
    }),
  });
  return assertRemoteResponse("code", response, "Code mutation failed over the remote session.");
}

/** Provider model catalog read (provider.list-models). */
export async function exerciseRemoteProviderSurface(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "provider");
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/providers/bootstrap",
  });
  return assertRemoteResponse(
    "provider",
    response,
    "Provider model list failed over the remote session.",
  );
}

/** Non-secret settings read (settings.read-non-secret). */
export async function exerciseRemoteSettingsSurface(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<{ readonly ok: true }> {
  const connection = guardMutation(input.bridge, "settings");
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/agent-profiles",
  });
  return assertRemoteResponse(
    "settings",
    response,
    "Settings read failed over the remote session.",
  );
}

export function isRemoteProductMutationFailure(
  error: unknown,
): error is RemoteProductMutationFailure {
  return error instanceof RemoteProductMutationFailure;
}

export function isRemoteConnectionOffline(error: unknown): boolean {
  return (
    (error instanceof RemoteProductMutationFailure && error.category === "offline") ||
    (error instanceof RemoteConnectionError && error.category === "unauthorized")
  );
}
