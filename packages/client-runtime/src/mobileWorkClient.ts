import {
  decodeBindingRevisionId,
  decodeStartWorkThreadTurnCommand,
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommandResult,
  decodeWorkThreadTranscript,
  decodeWorkTurnLookupResult,
  decodeProjectBootstrap,
  LOCAL_HOST_ID,
  type StartWorkThreadTurnCommand,
  type WorkThread,
  type WorkThreadTranscript,
  type WorkTurnState,
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

async function decodeJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      `${failureMessage} The host returned an invalid response.`,
    );
  }
}

/** The host-owned Work thread as its inventory reports it, or unavailable. */
export async function loadMobileWorkThread(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<WorkThread> {
  const bootstrap = await decodeJson(
    await transport.authenticatedFetch({ method: "GET", path: "/api/work/threads/bootstrap" }),
    decodeWorkThreadBootstrap,
    "Could not load Work threads from the host.",
  );
  const thread = bootstrap.threads.find((entry) => String(entry.id) === threadId);
  if (thread === undefined) {
    throw new MobileInboxFailure("unavailable", "Work thread is not available on this host.");
  }
  return thread;
}

/** The durable turns of a Work thread, oldest first. */
export async function loadMobileWorkTranscript(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<WorkThreadTranscript> {
  return decodeJson(
    await transport.authenticatedFetch({
      method: "GET",
      path: `/api/work/turns/transcript/${encodeURIComponent(threadId)}`,
    }),
    decodeWorkThreadTranscript,
    "Could not load the Work transcript from the host.",
  );
}

/**
 * Start a turn on an existing Work thread. Authority is the thread's own:
 * its Project, binding, working directory, provider, and model, confined to
 * the project root. The phone chooses none of it, so a follow-up can never
 * reach past what the thread was created with.
 */
export async function sendMobileWorkTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly thread: WorkThread;
  readonly prompt: string;
}): Promise<WorkTurnState> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MobileInboxFailure("unavailable", "Prompt text is required.");
  }
  if (input.thread.bindingRevisionId === undefined) {
    throw new MobileInboxFailure(
      "unavailable",
      "This Work thread has no bound folder; continue it on the host.",
    );
  }
  let command: StartWorkThreadTurnCommand;
  try {
    command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: globalThis.crypto.randomUUID(),
      threadId: input.thread.id,
      turnId: globalThis.crypto.randomUUID(),
      prompt,
      authority: {
        hostId: LOCAL_HOST_ID,
        projectId: input.thread.projectId,
        bindingRevisionId: input.thread.bindingRevisionId,
        workingDirectory: input.thread.workingDirectory ?? ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: input.thread.providerInstanceId,
        modelId: input.thread.modelId,
      },
    });
  } catch {
    throw new MobileInboxFailure("unavailable", "The Work turn could not be prepared.");
  }
  const result = await decodeJson(
    await input.transport.authenticatedFetch({
      method: "POST",
      path: "/api/work/turns",
      body: JSON.stringify(command),
    }),
    decodeWorkTurnLookupResult,
    "The Work turn could not be started on the host.",
  );
  if (result.kind !== "accepted") {
    throw new MobileInboxFailure("unavailable", "The host did not accept the Work turn.");
  }
  return result.turn;
}

/** Create a Work thread on the host without starting a turn. */
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
  const thread = await createWorkThreadOnHost(input);
  return workRow(input.transport.hostId, thread);
}

async function createWorkThreadOnHost(input: {
  readonly transport: MobileRemoteTransport;
  readonly projectId: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly bindingRevisionId: string;
  readonly workingDirectory?: string;
  readonly threadId?: string;
}): Promise<WorkThread> {
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
  return result.thread;
}

/**
 * Create a Work thread from a prompt and send that prompt as its first turn.
 * A thread whose first turn fails to start is still created and listed; the
 * failure says so, rather than reporting a thread that silently swallowed
 * what the user typed.
 */
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
  const thread = await createWorkThreadOnHost({
    transport: input.transport,
    projectId: input.projectId,
    title: titleFromPrompt(trimmed),
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    bindingRevisionId: input.bindingRevisionId,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
  });
  const row = workRow(input.transport.hostId, thread);
  try {
    await sendMobileWorkTurn({
      transport: input.transport,
      // The create command named the binding; a host that omits it from the
      // created thread still authorised exactly that binding.
      thread: {
        ...thread,
        bindingRevisionId:
          thread.bindingRevisionId ?? decodeBindingRevisionId(input.bindingRevisionId),
      },
      prompt: trimmed,
    });
  } catch (cause) {
    throw new MobileInboxFailure(
      cause instanceof MobileInboxFailure ? cause.category : "unavailable",
      "The Work thread was created, but its first turn could not start. Open it and send again.",
    );
  }
  return row;
}
