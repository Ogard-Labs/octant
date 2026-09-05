import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  decodeChatCommandResult,
  decodeChatThreadView,
  decodeCodeCommandResult,
  decodeCodeConversationPage,
  decodeCodeEvidenceBatchResponse,
  decodeCodeEvidenceReference,
  decodeCodeThreadView,
  decodeProjectBootstrap,
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommandResult,
  decodeWorkThreadTranscript,
  type ChatThreadView,
  type OctantMode,
  type WorkThread,
} from "@octant/contracts";
import {
  interruptAgentTurn,
  listAgentModels,
  refusalMessage,
  sendAgentPrompt,
  type HostRefusal,
} from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * One thread as the terminal shows it, whatever mode it lives in. Chat,
 * Work, and Code keep their own commands and transcripts on the host; this
 * is the small common shape the screen and line mode draw from.
 */
export type AgentTurnOutcome =
  | "queued"
  | "streaming"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentThreadTurn {
  readonly id: string;
  readonly at: string;
  readonly prompt: string;
  readonly reply: string;
  readonly replyAt: string;
  readonly outcome: AgentTurnOutcome;
  readonly inputTokens?: number;
}

export interface AgentThreadSnapshot {
  readonly id: string;
  readonly mode: OctantMode;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly version: number;
  readonly turns: ReadonlyArray<AgentThreadTurn>;
  readonly workItems: ReadonlyArray<{
    readonly title: string;
    readonly status: "pending" | "in-progress" | "blocked" | "completed" | "cancelled";
    readonly position: number;
  }>;
}

export interface AgentThreadPort {
  readonly mode: OctantMode;
  readonly threadId: string;
  read(): Promise<AgentThreadSnapshot | undefined>;
  send(
    prompt: string,
    extras?: {
      readonly attachmentIds?: ReadonlyArray<string>;
      readonly threadMentionIds?: ReadonlyArray<string>;
    },
  ): Promise<HostRefusal | { readonly kind: "sent" }>;
  interrupt(): Promise<
    HostRefusal | { readonly kind: "interrupted" } | { readonly kind: "nothing-running" }
  >;
}

export function isAgentSnapshotRunning(snapshot: AgentThreadSnapshot | undefined): boolean {
  const outcome = snapshot?.turns.at(-1)?.outcome;
  return outcome === "streaming" || outcome === "queued" || outcome === "waiting";
}

export function snapshotFromChat(view: ChatThreadView): AgentThreadSnapshot {
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  return {
    id: String(view.thread.id),
    mode: "chat",
    title: view.thread.title,
    providerInstanceId: String(view.thread.providerInstanceId),
    modelId: String(view.thread.modelId),
    version: view.thread.version,
    turns: view.turns.map((turn) => {
      const attempt = turn.attempts.at(-1);
      return {
        id: String(turn.id),
        at: turn.createdAt,
        prompt: bodies.get(String(turn.userMessageRef.contentId)) ?? "",
        reply:
          attempt === undefined
            ? ""
            : attempt.responseRefs.map((ref) => bodies.get(String(ref.contentId)) ?? "").join(""),
        replyAt: attempt?.createdAt ?? turn.createdAt,
        outcome: attempt?.outcome ?? "queued",
        ...(attempt?.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: attempt.usage.inputTokens }),
      };
    }),
    workItems: view.workItems.map((item) => ({
      title: item.title,
      status: item.status,
      position: item.position,
    })),
  };
}

export function agentThreadPort(
  session: OpenedLocalControlSession,
  mode: OctantMode,
  threadId: string,
): AgentThreadPort {
  if (mode === "work") return workThreadPort(session, threadId);
  if (mode === "code") return codeThreadPort(session, threadId);
  return chatThreadPort(session, threadId);
}

function chatThreadPort(session: OpenedLocalControlSession, threadId: string): AgentThreadPort {
  let view: ChatThreadView | undefined;
  const load = async () => {
    const response = await session.send({
      path: `/api/chat/threads/${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    view = response.status === 200 ? decodeChatThreadView(response.body) : undefined;
    return view;
  };
  return {
    mode: "chat",
    threadId,
    read: async () => {
      const loaded = await load();
      return loaded === undefined ? undefined : snapshotFromChat(loaded);
    },
    send: async (prompt, extras) => {
      const current = view ?? (await load());
      if (current === undefined)
        return { kind: "refused", message: "The thread could not be read." };
      return sendAgentPrompt(session, current, prompt, extras ?? {});
    },
    interrupt: async () => {
      const current = view ?? (await load());
      if (current === undefined) return { kind: "nothing-running" };
      return interruptAgentTurn(session, current);
    },
  };
}

// ── Work ─────────────────────────────────────────────────────────────────────

function workThreadPort(session: OpenedLocalControlSession, threadId: string): AgentThreadPort {
  let thread: WorkThread | undefined;
  const loadThread = async () => {
    const response = await session.send({ path: "/api/work/threads/bootstrap", method: "GET" });
    if (response.status !== 200) return undefined;
    thread = decodeWorkThreadBootstrap(response.body).threads.find(
      (entry) => String(entry.id) === threadId,
    );
    return thread;
  };
  const transcript = async () => {
    const response = await session.send({
      path: `/api/work/turns/transcript/${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    return response.status === 200 ? decodeWorkThreadTranscript(response.body) : undefined;
  };
  return {
    mode: "work",
    threadId,
    read: async () => {
      const [current, turns] = await Promise.all([loadThread(), transcript()]);
      if (current === undefined) return undefined;
      return {
        id: threadId,
        mode: "work",
        title: current.title,
        providerInstanceId: String(current.providerInstanceId),
        modelId: String(current.modelId),
        version: current.version,
        turns: (turns?.turns ?? []).map((turn) => ({
          id: String(turn.turnId),
          at: turn.acceptedAt,
          prompt: turn.prompt,
          reply: turn.response ?? "",
          replyAt: turn.updatedAt,
          outcome:
            turn.status === "accepted"
              ? "queued"
              : turn.status === "running"
                ? "streaming"
                : turn.status === "cancelled"
                  ? "cancelled"
                  : turn.status === "completed"
                    ? "completed"
                    : "failed",
        })),
        workItems: [],
      };
    },
    send: async (prompt) => {
      const current = thread ?? (await loadThread());
      if (current === undefined)
        return { kind: "refused", message: "The Work thread could not be read." };
      const projects = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
      const project =
        projects.status === 200
          ? decodeProjectBootstrap(projects.body).active.find(
              (entry) => String(entry.id) === String(current.projectId),
            )
          : undefined;
      if (project === undefined || project.type !== "work") {
        return { kind: "refused", message: "The Work Project is unavailable." };
      }
      const response = await session.send({
        path: "/api/work/turns",
        method: "POST",
        body: {
          kind: "start-work-thread-turn",
          requestId: randomUUID(),
          threadId,
          turnId: randomUUID(),
          prompt,
          authority: {
            hostId: "local",
            projectId: String(current.projectId),
            bindingRevisionId: String(project.bindingRevisionId),
            workingDirectory: String(current.workingDirectory ?? "."),
            confinementPosture: "project-root-confined",
            providerInstanceId: String(current.providerInstanceId),
            modelId: String(current.modelId),
          },
        },
      });
      if (response.status !== 200) {
        return { kind: "refused", message: refusalMessage(response, "The host refused the turn.") };
      }
      return { kind: "sent" };
    },
    interrupt: async () => {
      const turns = await transcript();
      const running = turns?.turns.find(
        (turn) => turn.status === "running" || turn.status === "accepted",
      );
      if (running === undefined) return { kind: "nothing-running" };
      const response = await session.send({
        path: "/api/work/turns/cancel",
        method: "POST",
        body: { kind: "cancel-work-turn", requestId: String(running.requestId), threadId },
      });
      if (response.status !== 200) {
        return {
          kind: "refused",
          message: refusalMessage(response, "The turn could not be stopped."),
        };
      }
      return { kind: "interrupted" };
    },
  };
}

// ── Code ─────────────────────────────────────────────────────────────────────

function codeThreadPort(session: OpenedLocalControlSession, threadId: string): AgentThreadPort {
  const view = async () => {
    const response = await session.send({
      path: `/api/code/threads/${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    return response.status === 200 ? decodeCodeThreadView(response.body) : undefined;
  };
  const conversation = async () => {
    const response = await session.send({
      path: `/api/code/threads/${encodeURIComponent(threadId)}/conversation?afterCursor=0&limit=50`,
      method: "GET",
    });
    return response.status === 200 ? decodeCodeConversationPage(response.body) : undefined;
  };
  return {
    mode: "code",
    threadId,
    read: async () => {
      const [current, page] = await Promise.all([view(), conversation()]);
      if (current === undefined) return undefined;
      const turns = page?.turns ?? [];
      const wanted = turns.flatMap((turn) => [
        { operationId: String(turn.operationId), contentId: String(turn.prompt.contentId) },
        ...turn.assistant.map((ref) => ({
          operationId: String(turn.operationId),
          contentId: String(ref.contentId),
        })),
      ]);
      const texts = new Map<string, string>();
      if (wanted.length > 0) {
        const batch = await session.send({
          path: "/api/code/evidence/batch",
          method: "POST",
          body: { threadId, items: wanted.slice(0, 200) },
        });
        if (batch.status === 200) {
          for (const item of decodeCodeEvidenceBatchResponse(batch.body).items) {
            texts.set(`${String(item.operationId)}:${String(item.contentId)}`, item.text);
          }
        }
      }
      return {
        id: threadId,
        mode: "code",
        title: current.thread.title,
        providerInstanceId: String(current.thread.providerInstanceId),
        modelId: String(current.thread.modelId),
        version: current.thread.version,
        turns: turns.map((turn) => ({
          id: String(turn.operationId),
          at: turn.startedAt,
          prompt: texts.get(`${String(turn.operationId)}:${String(turn.prompt.contentId)}`) ?? "",
          reply: turn.assistant
            .map((ref) => texts.get(`${String(turn.operationId)}:${String(ref.contentId)}`) ?? "")
            .join(""),
          replyAt: turn.updatedAt,
          outcome:
            turn.status === "waiting"
              ? "streaming"
              : turn.status === "incomplete"
                ? "streaming"
                : turn.status,
          ...(turn.usage?.inputTokens === undefined ? {} : { inputTokens: turn.usage.inputTokens }),
        })),
        workItems: [],
      };
    },
    send: async (prompt) => {
      const current = await view();
      if (current === undefined)
        return { kind: "refused", message: "The Code thread could not be read." };
      const staged = await session.send({
        path: "/api/code/evidence",
        method: "POST",
        bytes: new TextEncoder().encode(prompt),
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": threadId,
        },
      });
      if (staged.status !== 200) {
        return {
          kind: "refused",
          message: refusalMessage(staged, "The prompt could not be staged."),
        };
      }
      const response = await session.send({
        path: "/api/code/commands",
        method: "POST",
        body: {
          kind: "start-provider-turn",
          operationId: randomUUID(),
          threadId,
          checkoutId: String(current.checkout.id),
          sessionId: randomUUID(),
          prompt: decodeCodeEvidenceReference(staged.body),
        },
      });
      if (response.status !== 200) {
        return { kind: "refused", message: refusalMessage(response, "The host refused the turn.") };
      }
      return { kind: "sent" };
    },
    interrupt: async () => {
      const [current, page] = await Promise.all([view(), conversation()]);
      const running = page?.turns.find(
        (turn) => turn.status === "waiting" || turn.status === "incomplete",
      );
      if (current === undefined || running === undefined) return { kind: "nothing-running" };
      const response = await session.send({
        path: "/api/code/commands",
        method: "POST",
        body: {
          kind: "cancel-provider-turn",
          operationId: String(running.operationId),
          threadId,
          checkoutId: String(current.checkout.id),
        },
      });
      if (response.status !== 200) {
        return {
          kind: "refused",
          message: refusalMessage(response, "The turn could not be stopped."),
        };
      }
      return { kind: "interrupted" };
    },
  };
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * A new thread in the asked-for mode, through the same commands the app's
 * composer sends. Work and Code need a Project; a Code thread lands in the
 * current checkout, approval-gated, on the first harness model the host
 * offers unless the caller names one.
 */
export async function createAgentThread(
  session: OpenedLocalControlSession,
  input: {
    /** `auto` picks the Project whose folder holds the working directory, else Chat. */
    readonly mode: OctantMode | "auto";
    readonly title: string;
    readonly projectName?: string | undefined;
    readonly cwd?: string | undefined;
  },
): Promise<
  | HostRefusal
  | {
      readonly kind: "created";
      readonly threadId: string;
      readonly mode: OctantMode;
      readonly projectName?: string;
    }
> {
  const projects = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
  if (projects.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(projects, "Projects are unavailable on this host."),
    };
  }
  const active = decodeProjectBootstrap(projects.body).active;
  const wanted = input.projectName?.trim().toLowerCase();
  let project =
    wanted === undefined
      ? undefined
      : active.find((entry) => entry.name.trim().toLowerCase() === wanted);
  if (wanted !== undefined && project === undefined) {
    return { kind: "refused", message: `No Project named "${input.projectName}" on this host.` };
  }
  // The folder you are in decides, the way a coding CLI does: a registered
  // Code or Work Project that holds the working directory is where the
  // thread goes; anywhere else is a Chat thread.
  const folder = input.cwd ?? process.cwd();
  if (project === undefined && input.mode !== "chat") project = projectHolding(active, folder);
  const mode: OctantMode =
    input.mode !== "auto" ? input.mode : project === undefined ? "chat" : project.type;
  if (mode !== "chat" && (project === undefined || project.type !== mode)) {
    return {
      kind: "refused",
      message:
        project === undefined
          ? `This folder is not a ${mode === "work" ? "Work" : "Code"} Project yet. Add it with: octant project add ${JSON.stringify(folder)} --type ${mode}  — or name one with --project <name>.`
          : `"${project.name}" is a ${project.type} Project; --mode ${mode} needs a ${mode} one.`,
    };
  }
  if (mode === "chat") {
    const response = await session.send({
      path: "/api/chat/commands",
      method: "POST",
      body: {
        kind: "create-chat-thread",
        title: input.title,
        ...(project === undefined ? {} : { projectId: String(project.id) }),
      },
    });
    if (response.status !== 200) {
      return {
        kind: "refused",
        message: refusalMessage(response, "The host did not create a thread."),
      };
    }
    const created = decodeChatCommandResult(response.body);
    return created.kind === "thread-created"
      ? {
          kind: "created",
          threadId: String(created.thread.id),
          mode: "chat",
          ...(project === undefined ? {} : { projectName: project.name }),
        }
      : { kind: "refused", message: "The host did not create a thread." };
  }
  if (project === undefined || project.type !== mode) {
    return { kind: "refused", message: "The Project for this thread is unavailable." };
  }
  const model = (await listAgentModels(session))[0];
  if (model === undefined) {
    return {
      kind: "refused",
      message: "No harness endpoint offers a model yet. Add one in Settings → Providers.",
    };
  }
  if (mode === "work") {
    const threadId = randomUUID();
    const response = await session.send({
      path: "/api/work/threads/commands",
      method: "POST",
      body: {
        kind: "create-work-thread",
        threadId,
        projectId: String(project.id),
        title: input.title,
        providerInstanceId: model.instanceId,
        modelId: model.modelId,
        hostId: "local",
        bindingRevisionId: String(project.bindingRevisionId),
      },
    });
    if (response.status !== 200) {
      return {
        kind: "refused",
        message: refusalMessage(response, "The host did not create the Work thread."),
      };
    }
    const created = decodeWorkThreadCommandResult(response.body);
    return "kind" in created && created.kind === "thread-created"
      ? { kind: "created", threadId, mode: "work", projectName: project.name }
      : { kind: "refused", message: "The host did not create the Work thread." };
  }
  const prepared = await session.send({
    path: "/api/code/commands",
    method: "POST",
    body: { kind: "prepare-code-project-checkout", projectId: String(project.id) },
  });
  if (prepared.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(prepared, "The Code checkout could not be prepared."),
    };
  }
  const checkout = decodeCodeCommandResult(prepared.body);
  if (checkout.kind !== "checkout-prepared") {
    return { kind: "refused", message: "The Code checkout could not be prepared." };
  }
  if (checkout.checkout.head.kind !== "branch") {
    return {
      kind: "refused",
      message: "Create or select a branch before starting a Code thread in the current checkout.",
    };
  }
  const now = new Date().toISOString();
  const threadId = randomUUID();
  const response = await session.send({
    path: "/api/code/commands",
    method: "POST",
    body: {
      kind: "create-code-thread",
      thread: {
        id: threadId,
        projectId: String(project.id),
        bindingRevisionId: String(checkout.bindingRevisionId),
        repositoryId: String(checkout.checkout.repositoryId),
        checkoutId: String(checkout.checkout.id),
        title: input.title,
        lifecycle: "active",
        providerInstanceId: model.instanceId,
        modelId: model.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: String(checkout.checkout.head.name),
          remoteName: "origin",
          proposedBaseRepository: `local/${project.name}`,
          proposedBaseBranch: String(checkout.checkout.head.name),
          outcomeKind: "local-implementation",
          confirmedAt: now,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "The host did not create the Code thread."),
    };
  }
  const created = decodeCodeCommandResult(response.body);
  return created.kind === "thread-created"
    ? { kind: "created", threadId, mode: "code", projectName: project.name }
    : { kind: "refused", message: "The host did not create the Code thread." };
}

/** The Work or Code Project whose bound folder holds the directory, deepest match first. */
function projectHolding<
  T extends {
    readonly type: "chat" | "work" | "code";
    readonly binding?: { readonly canonicalRoot: string };
  },
>(active: ReadonlyArray<T>, directory: string): T | undefined {
  let here: string;
  try {
    here = realpathSync(resolve(directory));
  } catch {
    return undefined;
  }
  const holding = active
    .flatMap((entry) => {
      if ((entry.type !== "code" && entry.type !== "work") || entry.binding === undefined)
        return [];
      let root: string;
      try {
        root = realpathSync(entry.binding.canonicalRoot);
      } catch {
        root = entry.binding.canonicalRoot;
      }
      return here === root || here.startsWith(`${root}${sep}`) ? [{ entry, root }] : [];
    })
    .sort((a, b) => b.root.length - a.root.length);
  return holding[0]?.entry;
}
