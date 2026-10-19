import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  ChatThreadView,
  type OctantMode,
  type WorkThread,
  ChatCommandResult,
  CodeBootstrap,
  CodeCommandResult,
  CodeConversationPage,
  type CodeConversationTurn,
  CodeConversationWindow,
  CodeEvidenceBatchResponse,
  CodeEvidenceReference,
  CodeThreadView,
  ProjectBootstrap,
  WorkThreadBootstrap,
  WorkThreadCommandResult,
  WorkThreadTranscript,
  decodeHostAnswer,
} from "@octant/contracts";
import {
  answerAgentTurnQuestion,
  changeAgentModel,
  interruptAgentTurn,
  listAgentModels,
  refusalMessage,
  sendAgentPrompt,
  type HostRefusal,
} from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";
import { openAgentWindow } from "./agentWindow";

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

/**
 * A question the thread's turn is parked on. Chat keeps it on the turn's
 * attempt rather than in the harness session, so the thread port carries it:
 * `id` is the request id the host knows it by.
 */
export interface AgentPendingQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
  /** What choosing each option means, by index; present only when the provider gave any. */
  readonly descriptions?: ReadonlyArray<string | undefined>;
}

export interface AgentThreadSnapshot {
  readonly id: string;
  readonly mode: OctantMode;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly version: number;
  /** The thread's turns, oldest first: all of them, or its newest when `hasEarlier`. */
  readonly turns: ReadonlyArray<AgentThreadTurn>;
  /** The thread has turns older than the first in `turns`. */
  readonly hasEarlier?: boolean;
  readonly workItems: ReadonlyArray<{
    readonly title: string;
    readonly status: "pending" | "in-progress" | "blocked" | "completed" | "cancelled";
    readonly position: number;
  }>;
  /** Present only on a thread whose question is not in the harness session (Chat). */
  readonly pendingQuestion?: AgentPendingQuestion;
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
  /**
   * Answers a question `read` reported as pending. Absent where the harness
   * session holds the question (Work and Code); a refusal names why the host
   * would not take it, such as the question being answered elsewhere first.
   */
  answerQuestion?(
    question: AgentPendingQuestion,
    answer: string,
  ): Promise<HostRefusal | { readonly kind: "answered" }>;
}

export function isAgentSnapshotRunning(snapshot: AgentThreadSnapshot | undefined): boolean {
  const outcome = snapshot?.turns.at(-1)?.outcome;
  return outcome === "streaming" || outcome === "queued" || outcome === "waiting";
}

/** The question the newest turn is parked on, if its attempt is still waiting for the answer. */
export function pendingQuestionOf(view: ChatThreadView): AgentPendingQuestion | undefined {
  const attempt = view.turns.at(-1)?.attempts.at(-1);
  const question = attempt?.outcome === "waiting" ? attempt.pendingQuestion : undefined;
  if (question === undefined) return undefined;
  const hasMeanings = question.options.some((option) => option.description !== undefined);
  return {
    id: String(question.requestId),
    prompt: question.prompt,
    options: question.options.map((option) => option.label),
    ...(hasMeanings ? { descriptions: question.options.map((option) => option.description) } : {}),
  };
}

export function snapshotFromChat(view: ChatThreadView): AgentThreadSnapshot {
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  const pendingQuestion = pendingQuestionOf(view);
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
    ...(pendingQuestion === undefined ? {} : { pendingQuestion }),
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
    view = response.status === 200 ? decodeHostAnswer(ChatThreadView)(response.body) : undefined;
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
    answerQuestion: async (question, answer) => {
      // The host checks the answer against the thread's current version and
      // the attempt that still holds this question, so read both fresh.
      const current = await load();
      const turn = current?.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      if (
        current === undefined ||
        turn === undefined ||
        attempt === undefined ||
        pendingQuestionOf(current)?.id !== question.id
      ) {
        return { kind: "refused", message: "That question is no longer open." };
      }
      return answerAgentTurnQuestion(session, current, {
        turnId: String(turn.id),
        attemptId: String(attempt.id),
        requestId: question.id,
        answer,
      });
    },
  };
}

// ── Work ─────────────────────────────────────────────────────────────────────

function workThreadPort(session: OpenedLocalControlSession, threadId: string): AgentThreadPort {
  let thread: WorkThread | undefined;
  const loadThread = async () => {
    const response = await session.send({ path: "/api/work/threads/bootstrap", method: "GET" });
    if (response.status !== 200) return undefined;
    thread = decodeHostAnswer(WorkThreadBootstrap)(response.body).threads.find(
      (entry) => String(entry.id) === threadId,
    );
    return thread;
  };
  const transcript = async () => {
    const response = await session.send({
      path: `/api/work/turns/transcript/${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    return response.status === 200
      ? decodeHostAnswer(WorkThreadTranscript)(response.body)
      : undefined;
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
          ? decodeHostAnswer(ProjectBootstrap)(projects.body).active.find(
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
        body: {
          kind: "cancel-work-turn",
          requestId: String(running.requestId),
          threadId,
          turnId: String(running.turnId),
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

// ── Code ─────────────────────────────────────────────────────────────────────

/** How many of a Code thread's newest turns the terminal shows. */
export const CODE_THREAD_TURNS = 50;
/** The forward walk's page bound, for a host without the window read. */
const MAX_CODE_FORWARD_PAGES = 100;

interface CodeTurnsShown {
  /** The thread's newest turns, oldest first. */
  readonly turns: ReadonlyArray<CodeConversationTurn>;
  readonly hasEarlier: boolean;
}

function codeThreadPort(session: OpenedLocalControlSession, threadId: string): AgentThreadPort {
  const view = async () => {
    const response = await session.send({
      path: `/api/code/threads/${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    return response.status === 200 ? decodeHostAnswer(CodeThreadView)(response.body) : undefined;
  };
  const path = `/api/code/threads/${encodeURIComponent(threadId)}/conversation`;
  // A host without the window read answers 404 once and is then read forward.
  // The forward read lists turns oldest first, so only its tail is shown, and
  // the next read starts at the page that tail began on.
  const forward = { windowMissing: false, tailFrom: 0 };
  const forwardTail = async (): Promise<CodeTurnsShown | undefined> => {
    const pages: Array<{
      readonly from: number;
      readonly turns: ReadonlyArray<CodeConversationTurn>;
    }> = [];
    let cursor = forward.tailFrom;
    let reachedEnd = false;
    for (let count = 1; count <= MAX_CODE_FORWARD_PAGES; count += 1) {
      const response = await session.send({
        path: `${path}?afterCursor=${cursor}&limit=${MAX_CODE_CONVERSATION_PAGE_SIZE}`,
        method: "GET",
      });
      if (response.status !== 200) return undefined;
      const page = decodeHostAnswer(CodeConversationPage)(response.body);
      pages.push({ from: cursor, turns: page.turns });
      if (!page.hasMore) {
        reachedEnd = true;
        break;
      }
      if (page.nextCursor <= cursor) return undefined;
      cursor = page.nextCursor;
    }
    let first = pages.length;
    for (let counted = 0; first > 0 && counted < CODE_THREAD_TURNS;) {
      first -= 1;
      counted += pages[first]?.turns.length ?? 0;
    }
    forward.tailFrom = pages[first]?.from ?? forward.tailFrom;
    // A walk cut off by the page bound has not seen the newest turns, so it
    // shows nothing rather than an older run as the newest; the next read
    // continues from where this one got to.
    if (!reachedEnd) return undefined;
    const held = pages.slice(first).flatMap((page) => page.turns);
    return {
      turns: held.slice(-CODE_THREAD_TURNS),
      hasEarlier: forward.tailFrom > 0 || held.length > CODE_THREAD_TURNS,
    };
  };
  const conversation = async (): Promise<CodeTurnsShown | undefined> => {
    if (!forward.windowMissing) {
      const response = await session.send({
        path: `${path}/window?limit=${CODE_THREAD_TURNS}`,
        method: "GET",
      });
      if (response.status === 200) {
        const window = decodeHostAnswer(CodeConversationWindow)(response.body);
        return { turns: window.turns, hasEarlier: window.hasEarlier };
      }
      if (response.status !== 404) return undefined;
      forward.windowMissing = true;
    }
    return forwardTail();
  };
  const texts = new Map<string, string>();
  return {
    mode: "code",
    threadId,
    read: async () => {
      const [current, page] = await Promise.all([view(), conversation()]);
      // Without its turns the snapshot would show an empty or older thread as
      // current, and a branch would start from the wrong turn.
      if (current === undefined || page === undefined) return undefined;
      const turns = page.turns;
      const wanted = turns.flatMap((turn) => [
        { operationId: String(turn.operationId), contentId: String(turn.prompt.contentId) },
        ...turn.assistant.map((ref) => ({
          operationId: String(turn.operationId),
          contentId: String(ref.contentId),
        })),
      ]);
      // Evidence is content-addressed and never changes, so each piece is
      // fetched once; a streaming reply then costs one batch per new piece
      // rather than the whole thread on every read. The host refuses a batch
      // over its item limit outright, which left a long reply blank.
      const missing = wanted.filter((item) => !texts.has(`${item.operationId}:${item.contentId}`));
      for (let start = 0; start < missing.length; start += MAX_CODE_EVIDENCE_BATCH_ITEMS) {
        const batch = await session.send({
          path: "/api/code/evidence/batch",
          method: "POST",
          body: { threadId, items: missing.slice(start, start + MAX_CODE_EVIDENCE_BATCH_ITEMS) },
        });
        if (batch.status !== 200) break;
        for (const item of decodeHostAnswer(CodeEvidenceBatchResponse)(batch.body).items) {
          texts.set(`${String(item.operationId)}:${String(item.contentId)}`, item.text);
        }
      }
      return {
        id: threadId,
        mode: "code",
        title: current.thread.title,
        providerInstanceId: String(current.thread.providerInstanceId),
        modelId: String(current.thread.modelId),
        version: current.thread.version,
        ...(page.hasEarlier ? { hasEarlier: true } : {}),
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
        method: "PUT",
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
          prompt: decodeHostAnswer(CodeEvidenceReference)(staged.body),
        },
      });
      if (response.status !== 200) {
        return { kind: "refused", message: refusalMessage(response, "The host refused the turn.") };
      }
      // A turn the host refused before it began — a paused run, a missing
      // checkout — still answers 200, with the refusal as the result. Taking
      // that for "sent" printed the thread's previous reply as if it were new.
      const refusal = codeTurnRefusal(response.body);
      return refusal === undefined ? { kind: "sent" } : { kind: "refused", message: refusal };
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
 * current checkout, approval-gated unless the Project remembers Full access,
 * on the first harness model the host offers unless the caller names one.
 */
export async function createAgentThread(
  session: OpenedLocalControlSession,
  input: {
    /** `auto` picks the Project whose folder holds the working directory, else Chat. */
    readonly mode: OctantMode | "auto";
    readonly title: string;
    readonly projectName?: string | undefined;
    readonly cwd?: string | undefined;
    /** `model` or `endpoint/model`; the first harness model when absent. */
    readonly model?: string | undefined;
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
  const active = decodeHostAnswer(ProjectBootstrap)(projects.body).active;
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
    const models = input.model === undefined ? [] : await listAgentModels(session, "chat");
    const model = input.model === undefined ? undefined : pickAgentModel(models, input.model);
    if (input.model !== undefined && model === undefined) {
      return {
        kind: "refused",
        message: `No unique provider/model matches "${input.model}". Models here: ${models.map((entry) => `${entry.endpoint}/${entry.modelId}`).join(", ") || "none"}.`,
      };
    }
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
    const created = decodeHostAnswer(ChatCommandResult)(response.body);
    if (created.kind !== "thread-created") {
      return { kind: "refused", message: "The host did not create a thread." };
    }
    // Creation uses the host defaults. Apply the explicit choice through the
    // same command as the composer before this thread can receive a prompt.
    if (model !== undefined) {
      const changed = await changeAgentModel(session, created, model);
      if (changed.kind === "refused") return changed;
    }
    // The harness session routes (questions, pause, follow-ups) answer only a
    // window that has the thread open, a Chat thread included.
    const threadOpened = await openAgentWindow(session, {
      mode: "chat",
      ...(project === undefined ? {} : { project: { id: String(project.id), name: project.name } }),
      thread: { id: String(created.thread.id), title: input.title },
    });
    return threadOpened.kind === "refused"
      ? threadOpened
      : {
          kind: "created",
          threadId: String(created.thread.id),
          mode: "chat",
          ...(project === undefined ? {} : { projectName: project.name }),
        };
  }
  if (project === undefined || project.type !== mode) {
    return { kind: "refused", message: "The Project for this thread is unavailable." };
  }
  const models = await listAgentModels(session);
  const model = input.model === undefined ? models[0] : pickAgentModel(models, input.model);
  if (model === undefined) {
    return {
      kind: "refused",
      message:
        input.model === undefined
          ? "No harness endpoint offers a model yet. Add one in Settings → Providers."
          : `No harness endpoint offers "${input.model}". Models here: ${models.map((entry) => `${entry.endpoint}/${entry.modelId}`).join(", ") || "none"}.`,
    };
  }
  const projectOpened = await openAgentWindow(session, {
    mode,
    projectId: String(project.id),
    projectName: project.name,
  });
  if (projectOpened.kind === "refused") return projectOpened;
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
    const created = decodeHostAnswer(WorkThreadCommandResult)(response.body);
    if (!("kind" in created) || created.kind !== "thread-created") {
      return { kind: "refused", message: "The host did not create the Work thread." };
    }
    const threadOpened = await openAgentWindow(session, {
      mode,
      projectId: String(project.id),
      projectName: project.name,
      thread: { id: threadId, title: input.title },
    });
    return threadOpened.kind === "refused"
      ? threadOpened
      : { kind: "created", threadId, mode: "work", projectName: project.name };
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
  const checkout = decodeHostAnswer(CodeCommandResult)(prepared.body);
  if (checkout.kind !== "checkout-prepared") {
    return { kind: "refused", message: "The Code checkout could not be prepared." };
  }
  if (checkout.checkout.head.kind !== "branch") {
    return {
      kind: "refused",
      message: "Create or select a branch before starting a Code thread in the current checkout.",
    };
  }
  // The app's composer asks for project-default Full access only when the
  // person chose Remember for this Project, and the host grants that request
  // without a per-thread confirmation only while the Project still remembers
  // it. Asking the same way lets a terminal thread follow `octant project
  // access <name> full-access`; anywhere else it starts approval-gated, and
  // the host refuses a remembered request the Project no longer backs.
  const remembered = project.type === "code" && project.codeAccessPersistence === "project-default";
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
        executionPolicy: remembered ? "full-access" : "approval-gated",
        permissionPersistence: remembered ? "project-default" : "current-session",
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
  const created = decodeHostAnswer(CodeCommandResult)(response.body);
  if (created.kind !== "thread-created") {
    return { kind: "refused", message: "The host did not create the Code thread." };
  }
  const threadOpened = await openAgentWindow(session, {
    mode,
    projectId: String(project.id),
    projectName: project.name,
    thread: { id: threadId, title: input.title },
  });
  return threadOpened.kind === "refused"
    ? threadOpened
    : { kind: "created", threadId, mode: "code", projectName: project.name };
}

/**
 * Finds an existing Work or Code thread — the one named, or the latest — and
 * opens it in this terminal's window. A thread's Project decides what the
 * window may reach, so the folder you are in (or `--project`) is searched
 * first, then every other Work and Code Project. A named thread found in none
 * of them is left to the Chat port.
 */
export async function attachAgentThread(
  session: OpenedLocalControlSession,
  input: {
    readonly threadId?: string | undefined;
    readonly mode: OctantMode | "auto";
    readonly projectName?: string | undefined;
    readonly cwd?: string | undefined;
  },
): Promise<
  | HostRefusal
  | { readonly kind: "not-found" }
  | {
      readonly kind: "attached";
      readonly threadId: string;
      readonly mode: "work" | "code";
      readonly projectName: string;
    }
> {
  const projects = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
  if (projects.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(projects, "Projects are unavailable on this host."),
    };
  }
  const active = decodeHostAnswer(ProjectBootstrap)(projects.body).active.filter(
    (entry) =>
      (entry.type === "code" || entry.type === "work") &&
      (input.mode === "auto" || input.mode === entry.type),
  );
  const wanted = input.projectName?.trim().toLowerCase();
  const first =
    wanted === undefined
      ? projectHolding(active, input.cwd ?? process.cwd())
      : active.find((entry) => entry.name.trim().toLowerCase() === wanted);
  // Without a thread id, "latest" only means something for the Project here.
  const candidates =
    input.threadId === undefined
      ? first === undefined
        ? []
        : [first]
      : [...(first === undefined ? [] : [first]), ...active.filter((entry) => entry !== first)];
  for (const project of candidates) {
    if (project.type !== "code" && project.type !== "work") continue;
    const mode = project.type;
    const opened = await openAgentWindow(session, {
      mode,
      projectId: String(project.id),
      projectName: project.name,
    });
    if (opened.kind === "refused") return opened;
    const threads = await projectThreads(session, mode, String(project.id));
    const thread =
      input.threadId === undefined
        ? threads[0]
        : threads.find((entry) => entry.id === input.threadId);
    if (thread === undefined) continue;
    const threadOpened = await openAgentWindow(session, {
      mode,
      projectId: String(project.id),
      projectName: project.name,
      thread,
    });
    if (threadOpened.kind === "refused") return threadOpened;
    return { kind: "attached", threadId: thread.id, mode, projectName: project.name };
  }
  return { kind: "not-found" };
}

/**
 * Opens an existing Chat thread in this terminal's window, with its Project
 * when it has one, so the host answers the thread's harness session.
 */
export async function openChatAgentThread(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<HostRefusal | { readonly kind: "opened" }> {
  const response = await session.send({
    path: `/api/chat/threads/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, `No Chat thread ${threadId} on this host.`),
    };
  }
  const { thread } = decodeHostAnswer(ChatThreadView)(response.body);
  let project: { readonly id: string; readonly name: string } | undefined;
  if (thread.projectId !== undefined) {
    const projects = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
    const found =
      projects.status === 200
        ? decodeHostAnswer(ProjectBootstrap)(projects.body).active.find(
            (entry) => String(entry.id) === String(thread.projectId),
          )
        : undefined;
    if (found === undefined) {
      return { kind: "refused", message: "The Project for this thread is unavailable." };
    }
    project = { id: String(found.id), name: found.name };
  }
  return await openAgentWindow(session, {
    mode: "chat",
    ...(project === undefined ? {} : { project }),
    thread: { id: threadId, title: thread.title },
  });
}

/**
 * Opens the thread a bare id names, whatever its mode, so one read of its
 * harness session is allowed: a Work or Code thread through its Project, any
 * other id as a Chat thread.
 */
export async function openAgentThreadById(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<HostRefusal | { readonly kind: "opened" }> {
  const attached = await attachAgentThread(session, { threadId, mode: "auto" });
  if (attached.kind === "refused") return attached;
  if (attached.kind === "attached") return { kind: "opened" };
  return await openChatAgentThread(session, threadId);
}

/** A Project's active threads in this mode, most recently updated first. */
async function projectThreads(
  session: OpenedLocalControlSession,
  mode: "work" | "code",
  projectId: string,
): Promise<ReadonlyArray<{ readonly id: string; readonly title: string }>> {
  const response = await session.send({
    path: mode === "code" ? "/api/code/bootstrap" : "/api/work/threads/bootstrap",
    method: "GET",
  });
  if (response.status !== 200) return [];
  const threads =
    mode === "code"
      ? decodeHostAnswer(CodeBootstrap)(response.body).threads
      : decodeHostAnswer(WorkThreadBootstrap)(response.body).threads;
  return threads
    .filter((thread) => String(thread.projectId) === projectId && thread.lifecycle === "active")
    .toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((thread) => ({ id: String(thread.id), title: thread.title }));
}

/**
 * The model a `--model` value names: a model id, or `endpoint/model` when the
 * same id is offered by more than one endpoint. Matching ignores case so a
 * typed name finds the listed one.
 */
export function pickAgentModel<T extends { readonly endpoint: string; readonly modelId: string }>(
  models: ReadonlyArray<T>,
  wanted: string,
): T | undefined {
  const value = wanted.trim().toLowerCase();
  const qualified = models.filter(
    (entry) => `${entry.endpoint}/${entry.modelId}`.toLowerCase() === value,
  );
  if (qualified.length > 0) return qualified.length === 1 ? qualified[0] : undefined;
  const byId = models.filter((entry) => entry.modelId.toLowerCase() === value);
  return byId.length === 1 ? byId[0] : undefined;
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

/** The reason a Code turn was refused before it started, or undefined when it started. */
function codeTurnRefusal(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const result = body as {
    readonly kind?: unknown;
    readonly state?: unknown;
    readonly failure?: { readonly message?: unknown };
  };
  const refused =
    result.kind === "operation-failed" ||
    (result.kind === "provider-turn-state" && result.state === "failed");
  if (!refused) return undefined;
  const message = result.failure?.message;
  return typeof message === "string" && message.length > 0 ? message : "The host refused the turn.";
}
