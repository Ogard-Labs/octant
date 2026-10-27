import { randomBytes, randomUUID } from "node:crypto";

/**
 * A packaged smoke's stand-in for a desktop window: it registers a window
 * authority with the bridge secret the smoke gave the packaged server, then
 * binds and opens a Code Project the way the desktop shell does, so the
 * smoke's requests carry the same authority a person's window would.
 */
export interface SmokeWindowAuthority {
  readonly windowId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly send: (path: string, body: unknown, step: string) => Promise<unknown>;
}

export interface SeededCodeProject {
  readonly projectId: string;
  readonly bindingRevisionId: unknown;
  readonly repositoryId: unknown;
  readonly checkoutId: unknown;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function registerWindowAuthority(
  serverUrl: string,
  desktopBridgeSecret: string,
): Promise<SmokeWindowAuthority> {
  const capability = randomBytes(32).toString("base64url");
  const rendererIdentity = randomBytes(32).toString("base64url");
  const windowId = randomUUID();
  const registered = await fetch(`${serverUrl}/api/desktop/window-authorities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": desktopBridgeSecret,
    },
    body: JSON.stringify({ windowId, capability, rendererIdentity }),
  });
  if (registered.status !== 204) {
    throw new Error("Packaged smoke could not register a window authority.");
  }
  const headers = {
    origin: "file://",
    "content-type": "application/json",
    "x-octant-window-capability": capability,
    "x-octant-renderer-identity": rendererIdentity,
  };
  return {
    windowId,
    headers,
    send: async (path, body, step) => {
      const response = await fetch(`${serverUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Packaged smoke could not ${step} (${response.status}).`);
      }
      return await response.json();
    },
  };
}

/** Code commands answer only for the Project the window has open. */
export async function openCodeProject(
  window: SmokeWindowAuthority,
  projectId: string,
): Promise<void> {
  const shell = await window.send("/api/shell/bootstrap", undefined, "bootstrap the shell");
  const workspace = isRecord(shell) && isRecord(shell.workspace) ? shell.workspace : undefined;
  if (!isRecord(shell) || workspace === undefined) {
    throw new Error("Packaged smoke received no workspace.");
  }
  await window.send(
    "/api/shell/commands",
    {
      kind: "apply-workspace-operation",
      windowId: workspace.windowId,
      expectedVersion: shell.workspaceVersion,
      operation: {
        kind: "switch-project-surface",
        mode: "code",
        surface: { kind: "project", id: randomUUID(), projectId, mode: "code", title: "Smoke" },
      },
    },
    "open the Code Project",
  );
}

export async function createCodeProject(input: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly window: SmokeWindowAuthority;
  readonly repository: string;
  readonly name: string;
}): Promise<SeededCodeProject> {
  const { window } = input;
  const receipt = await fetch(`${input.serverUrl}/api/desktop/project-binding-receipts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": input.desktopBridgeSecret,
    },
    body: JSON.stringify({
      windowId: window.windowId,
      projectType: "code",
      path: input.repository,
    }),
  });
  const receiptBody: unknown = receipt.ok ? await receipt.json() : undefined;
  if (!isRecord(receiptBody) || typeof receiptBody.receiptId !== "string") {
    throw new Error(`Packaged smoke could not bind its repository (${receipt.status}).`);
  }
  const projectId = randomUUID();
  await window.send(
    "/api/projects/commands",
    {
      kind: "create-code-project",
      projectId,
      expectedVersion: 0,
      name: input.name,
      receiptId: receiptBody.receiptId,
      hostId: "local",
    },
    "create a Code Project",
  );
  await openCodeProject(window, projectId);
  const prepared = await window.send(
    "/api/code/commands",
    { kind: "prepare-code-project-checkout", projectId },
    "prepare the checkout",
  );
  const checkout =
    isRecord(prepared) && isRecord(prepared.checkout) ? prepared.checkout : undefined;
  if (!isRecord(prepared) || checkout === undefined) {
    throw new Error("Packaged smoke received no prepared checkout.");
  }
  return {
    projectId,
    bindingRevisionId: prepared.bindingRevisionId,
    repositoryId: checkout.repositoryId,
    checkoutId: checkout.id,
  };
}

/**
 * A local compatible provider nothing listens behind, and a Code thread on
 * the Project's checkout that names it. No smoke that uses this starts a turn.
 */
export async function createUnusedProviderThread(input: {
  readonly window: SmokeWindowAuthority;
  readonly project: SeededCodeProject;
  readonly title: string;
  readonly executionPolicy: "approval-gated" | "plan";
}): Promise<string> {
  const { window, project } = input;
  const providerInstanceId = randomUUID();
  const modelId = "packaged-smoke";
  await window.send(
    "/api/providers/commands",
    {
      kind: "create-openai-compatible-provider",
      instanceId: providerInstanceId,
      expectedVersion: 0,
      displayName: input.title,
      configuration: {
        kind: "openai-compatible-http",
        // Nothing listens here; the smoke never starts a turn.
        baseUrl: "http://127.0.0.1:9/v1",
        authentication: "none",
        protocol: "chat-completions",
        manualModelIds: [modelId],
      },
    },
    "create a provider",
  );
  const threadId = randomUUID();
  const now = new Date().toISOString();
  const created = await window.send(
    "/api/code/commands",
    {
      kind: "create-code-thread",
      thread: {
        id: threadId,
        projectId: project.projectId,
        bindingRevisionId: project.bindingRevisionId,
        repositoryId: project.repositoryId,
        checkoutId: project.checkoutId,
        title: input.title,
        lifecycle: "active",
        providerInstanceId,
        modelId,
        executionPolicy: input.executionPolicy,
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "main",
          remoteName: "origin",
          proposedBaseRepository: "local/smoke",
          proposedBaseBranch: "main",
          outcomeKind: "local-implementation",
          confirmedAt: now,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    "create a Code thread",
  );
  if (!isRecord(created) || created.kind !== "thread-created") {
    throw new Error("Packaged smoke did not create its Code thread.");
  }
  return threadId;
}
