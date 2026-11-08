import { randomUUID } from "node:crypto";
import { registerWindowAuthority, isRecord } from "./packaged-smoke-code-project";
import { CHILD_FIXTURE_MODEL, CHILD_FIXTURE_PARENT_TASK } from "./packaged-browser-child-provider";

/**
 * Setup only: use admitted local commands for the owned folder/model/thread,
 * then revoke the setup window. All acceptance actions use the actual app UI.
 */
export async function createOwnedChildProject(input: {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly folder: string;
  readonly providerUrl: string;
  readonly providerInstanceId: string;
}) {
  const window = await registerWindowAuthority(input.serverUrl, input.desktopBridgeSecret);
  const projectId = randomUUID();
  const threadId = randomUUID();
  try {
    const receipt = await fetch(`${input.serverUrl}/api/desktop/project-binding-receipts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": input.desktopBridgeSecret,
      },
      body: JSON.stringify({ windowId: window.windowId, projectType: "work", path: input.folder }),
      signal: AbortSignal.timeout(3000),
    });
    const binding: unknown = await receipt.json();
    if (!receipt.ok || !isRecord(binding) || typeof binding.receiptId !== "string")
      throw Error("The normal owned Work folder binding was refused.");
    const created = await window.send(
      "/api/projects/commands",
      {
        kind: "create-work-project",
        projectId,
        expectedVersion: 0,
        name: "Owned child Browser Project",
        receiptId: binding.receiptId,
        hostId: "local",
      },
      "create the owned Work Project",
    );
    if (
      !isRecord(created) ||
      !isRecord(created.project) ||
      !Array.isArray(created.project.bindingHistory)
    )
      throw Error("The normal Work command returned no Project binding.");
    const revision: unknown = created.project.bindingHistory.at(-1);
    if (!isRecord(revision) || typeof revision.revisionId !== "string")
      throw Error("The owned Work Project has no binding revision.");
    const shell = await window.send("/api/shell/bootstrap", undefined, "read the setup workspace");
    if (!isRecord(shell) || !isRecord(shell.workspace)) throw Error("No setup workspace.");
    await window.send(
      "/api/shell/commands",
      {
        kind: "apply-workspace-operation",
        windowId: shell.workspace.windowId,
        expectedVersion: shell.workspaceVersion,
        operation: {
          kind: "switch-project-surface",
          mode: "work",
          surface: {
            kind: "project",
            id: randomUUID(),
            projectId,
            mode: "work",
            title: "Owned child Browser Project",
          },
        },
      },
      "open the owned setup Project",
    );
    await window.send(
      "/api/providers/commands",
      {
        kind: "create-openai-compatible-provider",
        instanceId: input.providerInstanceId,
        expectedVersion: 0,
        displayName: "Owned child Browser fixture",
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: input.providerUrl,
          authentication: "none",
          protocol: "chat-completions",
          manualModelIds: [CHILD_FIXTURE_MODEL],
        },
      },
      "create the owned local provider",
    );
    await window.send(
      "/api/providers/commands",
      {
        kind: "probe-provider",
        instanceId: input.providerInstanceId,
      },
      "probe the owned local provider",
    );
    await window.send(
      "/api/providers/commands",
      {
        kind: "verify-model-tools",
        instanceId: input.providerInstanceId,
        modelId: CHILD_FIXTURE_MODEL,
      },
      "verify actual tool support on the local fixture",
    );
    await window.send(
      "/api/work/threads/commands",
      {
        kind: "create-work-thread",
        threadId,
        projectId,
        title: CHILD_FIXTURE_PARENT_TASK,
        providerInstanceId: input.providerInstanceId,
        modelId: CHILD_FIXTURE_MODEL,
        hostId: "local",
        bindingRevisionId: revision.revisionId,
      },
      "create the owned idle Work thread",
    );
    return { projectId, threadId };
  } finally {
    const revoked = await fetch(`${input.serverUrl}/api/desktop/window-authorities`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": input.desktopBridgeSecret,
      },
      body: JSON.stringify({ windowId: window.windowId }),
      signal: AbortSignal.timeout(3000),
    });
    if (revoked.status !== 204) throw Error("The setup authority could not be revoked.");
  }
}
