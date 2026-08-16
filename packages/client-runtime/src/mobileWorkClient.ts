import {
  decodeWorkThreadCommandResult,
  decodeProjectBootstrap,
  LOCAL_HOST_ID,
  type WorkThread,
  type ProjectSummary,
} from "@octant/contracts";
import {
  MobileInboxFailure,
  type MobileInboxRow,
  type MobileRemoteTransport,
} from "./mobileInboxClient";

export interface MobileWorkProjectOption {
  readonly projectId: string;
  readonly name: string;
  readonly bindingRevisionId: string;
}

function workRow(hostId: string, thread: WorkThread): MobileInboxRow {
  return {
    hostId,
    mode: "work",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
  };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "New work";
  if (line.length <= 72) return line;
  return `${line.slice(0, 71).trimEnd()}…`;
}

export function listMobileWorkProjects(
  projects: ReadonlyArray<ProjectSummary>,
): ReadonlyArray<MobileWorkProjectOption> {
  return projects
    .filter(
      (project): project is Extract<ProjectSummary, { readonly type: "work" }> =>
        project.type === "work" && project.lifecycle === "active",
    )
    .map((project) => ({
      projectId: String(project.id),
      name: project.name,
      bindingRevisionId: String(project.bindingRevisionId),
    }));
}

export async function fetchMobileWorkProjects(
  transport: MobileRemoteTransport,
): Promise<ReadonlyArray<MobileWorkProjectOption>> {
  const response = await transport.authenticatedFetch({
    method: "GET",
    path: "/api/projects/bootstrap",
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not load Work projects from the host.",
    );
  }
  try {
    const bootstrap = decodeProjectBootstrap(await response.json());
    return listMobileWorkProjects(bootstrap.active);
  } catch {
    throw new MobileInboxFailure("unavailable", "Host returned an invalid project bootstrap.");
  }
}

/**
 * Create a Work thread on the host. Steering remains inventory-only on
 * mobile until a later slice; this only creates the host-owned thread.
 */
export async function createMobileWorkThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly projectId: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly bindingRevisionId: string;
  readonly workingDirectory?: string;
  readonly threadId?: string;
}): Promise<MobileInboxRow> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new MobileInboxFailure("unavailable", "Work title is required.");
  }
  const threadId = input.threadId ?? globalThis.crypto.randomUUID();
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/work/threads/commands",
    body: JSON.stringify({
      kind: "create-work-thread",
      threadId,
      projectId: input.projectId,
      title,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
      // Commands execute on the host; "local" is the host's own HostId.
      hostId: LOCAL_HOST_ID,
      bindingRevisionId: input.bindingRevisionId,
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not create a Work thread on the host.",
    );
  }
  let result: ReturnType<typeof decodeWorkThreadCommandResult>;
  try {
    result = decodeWorkThreadCommandResult(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Work create returned an invalid response from the host.",
    );
  }
  if ("category" in result) {
    throw new MobileInboxFailure("unavailable", result.message);
  }
  if (result.kind !== "thread-created") {
    throw new MobileInboxFailure("unavailable", "Host did not confirm Work thread creation.");
  }
  return workRow(input.transport.hostId, result.thread);
}

export async function createMobileWorkFromPrompt(input: {
  readonly transport: MobileRemoteTransport;
  readonly prompt: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly bindingRevisionId: string;
  readonly workingDirectory?: string;
}): Promise<MobileInboxRow> {
  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) {
    throw new MobileInboxFailure("unavailable", "Prompt text is required.");
  }
  return createMobileWorkThread({
    transport: input.transport,
    projectId: input.projectId,
    title: titleFromPrompt(trimmed),
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    bindingRevisionId: input.bindingRevisionId,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
  });
}
