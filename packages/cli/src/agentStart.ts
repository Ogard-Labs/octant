import {
  CodeBootstrap,
  NativeHarnessSessionView,
  ProjectBootstrap,
  type OctantMode,
  type ProjectSummary,
  WorkThreadBootstrap,
  decodeHostAnswer,
} from "@octant/contracts";
import { PendingRequest } from "@octant/contracts/pending-requests";
import { listAgentThreads, refusalMessage, type HostRefusal } from "./agentHost";
import {
  agentThreadPort,
  isAgentSnapshotRunning,
  openAgentThreadById,
  type AgentThreadPort,
  type AgentTurnOutcome,
} from "./agentThread";
import type { OpenedLocalControlSession } from "./localControl";
import { openAgentWindow } from "./agentWindow";

/**
 * Starting and following a thread for a caller that does not sit at a
 * terminal: `octant agent --detach`, `octant agent status`, and the MCP server
 * other agents use. Everything goes through the same thread ports and routes as
 * `octant agent`, so the host decides authority exactly as it does for the app.
 */

export type AgentTurnStart =
  | HostRefusal
  | {
      readonly kind: "started";
      /** Absent when the host accepted the turn but had not listed it yet. */
      readonly turnId?: string;
      /**
       * Resolves when the send itself has answered. A Chat send answers only
       * once its turn has ended, so a caller keeps its session open until then.
       */
      readonly settled: Promise<void>;
    };

/** How long a start waits for the host to list the turn it accepted. */
const TURN_LISTED_TIMEOUT_MS = 30_000;

/**
 * Sends the prompt and resolves as soon as the host lists the new turn,
 * without waiting for the reply.
 */
export async function startAgentTurn(
  port: AgentThreadPort,
  prompt: string,
  options: { readonly pollIntervalMs?: number } = {},
): Promise<AgentTurnStart> {
  const baseline = await port.read();
  if (baseline === undefined) {
    return { kind: "refused", message: "The thread could not be read before sending. Try again." };
  }
  const before = baseline.turns.at(-1)?.id;
  // Held in an object so each check reads the send's answer as of now; it
  // lands while the reads below are awaited.
  const send: { answer?: HostRefusal | { readonly kind: "sent" } } = {};
  const sending = port
    .send(prompt)
    .catch((): HostRefusal => ({ kind: "refused", message: "The host refused the turn." }))
    .then((answer) => {
      send.answer = answer;
    });
  const interval = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + TURN_LISTED_TIMEOUT_MS;
  for (;;) {
    const turn = (await port.read())?.turns.at(-1);
    if (send.answer?.kind === "refused") return send.answer;
    if (turn !== undefined && turn.id !== before) {
      return { kind: "started", turnId: turn.id, settled: sending };
    }
    if (Date.now() >= deadline) {
      return send.answer?.kind === "sent"
        ? { kind: "started", settled: sending }
        : {
            kind: "refused",
            message:
              "The host did not show the new turn in time. Read the thread to see whether it started.",
          };
    }
    await Promise.race([pause(interval), sending]);
  }
}

/** A question the thread waits on that a caller of this module may answer. */
export interface AgentOpenQuestion {
  readonly questionId: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
}

/** A request only the person answers, in Octant: approvals, decisions, and the like. */
export interface AgentPersonRequest {
  readonly kind: string;
  readonly text?: string;
}

export interface AgentThreadState {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly title: string;
  readonly projectName?: string;
  /**
   * `waiting-for-answer`: a question this caller can answer is open.
   * `waiting-for-person`: an approval or other request waits on the person in
   * Octant. `running`: the turn is working. `idle`: nothing is running.
   */
  readonly status: "running" | "waiting-for-answer" | "waiting-for-person" | "idle";
  readonly turns: ReadonlyArray<{
    readonly turnId: string;
    readonly prompt: string;
    readonly reply: string;
    readonly outcome: AgentTurnOutcome;
  }>;
  readonly questions: ReadonlyArray<AgentOpenQuestion>;
  readonly waitingInOctant: ReadonlyArray<AgentPersonRequest>;
  /**
   * The host's list of what waits on the person could not be read whole (it
   * failed, or held more than it returned), so an empty `waitingInOctant`
   * does not prove nothing waits.
   */
  readonly waitingIncomplete?: true;
}

/**
 * The thread as a caller following it sees it: its newest turns, whether it
 * is working, and what it waits on. The window must already have the thread
 * open (`openAgentThreadById`), as the host answers reads only then.
 */
export async function readAgentThreadState(
  session: OpenedLocalControlSession,
  opened: { readonly threadId: string; readonly mode: OctantMode; readonly projectName?: string },
  options: { readonly turns?: number } = {},
): Promise<HostRefusal | { readonly kind: "read"; readonly state: AgentThreadState }> {
  const port = agentThreadPort(session, opened.mode, opened.threadId);
  const snapshot = await port.read();
  if (snapshot === undefined) return { kind: "refused", message: "The thread could not be read." };
  const questions = [
    ...(await harnessQuestions(session, opened.threadId)),
    ...(snapshot.pendingQuestion === undefined
      ? []
      : [
          {
            questionId: snapshot.pendingQuestion.id,
            prompt: snapshot.pendingQuestion.prompt,
            options: snapshot.pendingQuestion.options,
          },
        ]),
  ];
  const waiting = await personRequests(session, opened.threadId);
  const waitingInOctant = waiting.requests;
  return {
    kind: "read",
    state: {
      threadId: opened.threadId,
      mode: opened.mode,
      title: snapshot.title,
      ...(opened.projectName === undefined ? {} : { projectName: opened.projectName }),
      status:
        questions.length > 0
          ? "waiting-for-answer"
          : waitingInOctant.length > 0
            ? "waiting-for-person"
            : isAgentSnapshotRunning(snapshot)
              ? "running"
              : "idle",
      turns: snapshot.turns.slice(-Math.max(1, options.turns ?? 1)).map((turn) => ({
        turnId: turn.id,
        prompt: turn.prompt,
        reply: turn.reply,
        outcome: turn.outcome,
      })),
      questions,
      waitingInOctant,
      ...(waiting.complete ? {} : { waitingIncomplete: true as const }),
    },
  };
}

/** Opens a thread by id in this window and reads its state. */
export async function openAndReadAgentThread(
  session: OpenedLocalControlSession,
  threadId: string,
  options: { readonly turns?: number } = {},
): Promise<HostRefusal | { readonly kind: "read"; readonly state: AgentThreadState }> {
  const opened = await openAgentThreadById(session, threadId);
  if (opened.kind === "refused") return opened;
  return await readAgentThreadState(
    session,
    {
      threadId,
      mode: opened.mode,
      ...(opened.projectName === undefined ? {} : { projectName: opened.projectName }),
    },
    options,
  );
}

/**
 * Follows the thread until its turn ends, it waits on someone, the deadline
 * passes, or the signal aborts; answers the last state read either way.
 */
export async function waitForAgentTurn(
  session: OpenedLocalControlSession,
  opened: { readonly threadId: string; readonly mode: OctantMode; readonly projectName?: string },
  options: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<
  | HostRefusal
  | { readonly kind: "read"; readonly state: AgentThreadState; readonly timedOut: boolean }
> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.pollIntervalMs ?? 1_000;
  for (;;) {
    const read = await readAgentThreadState(session, opened);
    if (read.kind === "refused") return read;
    if (read.state.status !== "running") return { ...read, timedOut: false };
    if (Date.now() >= deadline || options.signal?.aborted === true) {
      return { ...read, timedOut: true };
    }
    await pause(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
  }
}

/** Stops the thread's running turn, if one is running. */
export async function stopAgentTurn(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<HostRefusal | { readonly kind: "interrupted" | "nothing-running" }> {
  const opened = await openAgentThreadById(session, threadId);
  if (opened.kind === "refused") return opened;
  return await agentThreadPort(session, opened.mode, threadId).interrupt();
}

/**
 * Answers an open question: a harness question through the session route the
 * Agents tab uses, a Chat turn's question through the thread port. Anything
 * else (an approval, a decision, a provider's own request) is the person's to
 * answer in Octant, so it is refused here.
 */
export async function answerAgentQuestion(
  session: OpenedLocalControlSession,
  input: { readonly threadId: string; readonly questionId: string; readonly answer: string },
): Promise<HostRefusal | { readonly kind: "answered" }> {
  const opened = await openAgentThreadById(session, input.threadId);
  if (opened.kind === "refused") return opened;
  const harness = await harnessQuestions(session, input.threadId);
  if (harness.some((question) => question.questionId === input.questionId)) {
    const response = await session.send({
      path: `/api/native-harness/sessions/${encodeURIComponent(input.threadId)}/questions`,
      method: "POST",
      body: { questionId: input.questionId, answer: input.answer },
    });
    return response.status === 200
      ? { kind: "answered" }
      : { kind: "refused", message: refusalMessage(response, "The host refused the answer.") };
  }
  const port = agentThreadPort(session, opened.mode, input.threadId);
  const asked = (await port.read())?.pendingQuestion;
  if (asked !== undefined && asked.id === input.questionId && port.answerQuestion !== undefined) {
    return await port.answerQuestion(asked, input.answer);
  }
  return {
    kind: "refused",
    message:
      "That question is not open on this thread. Read the thread for the questions that can be answered here; approvals and other requests are answered by the person in Octant.",
  };
}

export interface AgentProjectRow {
  readonly name: string;
  readonly type: "chat" | "work" | "code";
  readonly folder?: string;
}

/** The host's active Projects, or why they could not be read. */
export async function readActiveProjects(
  session: OpenedLocalControlSession,
): Promise<
  HostRefusal | { readonly kind: "read"; readonly active: ReadonlyArray<ProjectSummary> }
> {
  const response = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "Projects are unavailable on this host."),
    };
  }
  return { kind: "read", active: decodeHostAnswer(ProjectBootstrap)(response.body).active };
}

export function projectRow(project: ProjectSummary): AgentProjectRow {
  return {
    name: project.name,
    type: project.type,
    ...(project.type === "chat" ? {} : { folder: project.binding.canonicalRoot }),
  };
}

export interface AgentThreadRow {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly title: string;
  readonly projectName?: string;
  readonly updatedAt: string;
}

/**
 * Active threads, most recently updated first: one Project's when `project`
 * is given, otherwise every Work and Code Project's and the Chat threads.
 */
export async function listRecentAgentThreads(
  session: OpenedLocalControlSession,
  input: { readonly projects: ReadonlyArray<ProjectSummary>; readonly project?: ProjectSummary },
): Promise<ReadonlyArray<AgentThreadRow>> {
  const names = new Map(input.projects.map((project) => [String(project.id), project.name]));
  const wanted = input.project === undefined ? undefined : String(input.project.id);
  const inScope = (projectId: string | undefined) =>
    wanted === undefined || (projectId !== undefined && projectId === wanted);
  const row = (
    mode: OctantMode,
    thread: {
      readonly id: unknown;
      readonly title: string;
      readonly projectId?: unknown;
      readonly updatedAt: unknown;
    },
  ): AgentThreadRow => {
    const projectName =
      thread.projectId === undefined ? undefined : names.get(String(thread.projectId));
    return {
      threadId: String(thread.id),
      mode,
      title: thread.title,
      ...(projectName === undefined ? {} : { projectName }),
      updatedAt: String(thread.updatedAt),
    };
  };
  const rows: AgentThreadRow[] = [];
  if (input.project === undefined || input.project.type === "code") {
    const response = await session.send({ path: "/api/code/bootstrap", method: "GET" });
    if (response.status === 200) {
      for (const thread of decodeHostAnswer(CodeBootstrap)(response.body).threads) {
        if (thread.lifecycle === "active" && inScope(String(thread.projectId)))
          rows.push(row("code", thread));
      }
    }
  }
  if (input.project === undefined || input.project.type === "work") {
    const response = await session.send({ path: "/api/work/threads/bootstrap", method: "GET" });
    if (response.status === 200) {
      for (const thread of decodeHostAnswer(WorkThreadBootstrap)(response.body).threads) {
        if (thread.lifecycle === "active" && inScope(String(thread.projectId)))
          rows.push(row("work", thread));
      }
    }
  }
  if (input.project === undefined || input.project.type === "chat") {
    for (const thread of await listAgentThreads(session)) {
      const projectId = thread.projectId === undefined ? undefined : String(thread.projectId);
      if (inScope(projectId)) rows.push(row("chat", thread));
    }
  }
  return rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A thread title from the first line of a prompt, the way a person would name it. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "Agent";
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

async function harnessQuestions(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<ReadonlyArray<AgentOpenQuestion>> {
  const response = await session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) return [];
  const view = (response.body as { readonly view?: unknown } | undefined)?.view;
  if (view === null || view === undefined) return [];
  return decodeHostAnswer(NativeHarnessSessionView)(view)
    .questions.filter((question) => question.status === "pending")
    .map((question) => ({
      questionId: String(question.id),
      prompt: question.prompt,
      options: question.options,
    }));
}

/** One request on the host's Needs you list. */
export interface AgentWaitingRequest {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly mode: OctantMode;
  readonly kind: string;
  readonly text?: string;
  readonly waitingSince: string;
  /**
   * A harness question or a Chat turn's question, which `answer_question`
   * may answer once `read_thread` gives its id; everything else is the
   * person's to answer in Octant.
   */
  readonly answerableHere: boolean;
}

type WaitingRead =
  | HostRefusal
  | {
      readonly kind: "read";
      readonly requests: ReadonlyArray<AgentWaitingRequest>;
      readonly truncated: boolean;
    };

/**
 * One read of the Needs you list as this window may see it. The host lists a
 * Work or Code Project's requests (and the agents waiting in them) only to a
 * window that has that Project open, so the caller opens it first.
 */
async function readWaitingRows(session: OpenedLocalControlSession): Promise<WaitingRead> {
  const response = await session.send({ path: "/api/pending-requests", method: "GET" });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "What waits on the person is unavailable on this host."),
    };
  }
  const body = response.body as { readonly requests?: unknown; readonly truncated?: unknown };
  const rows = Array.isArray(body?.requests) ? body.requests : [];
  return {
    kind: "read",
    truncated: body?.truncated === true,
    requests: rows.flatMap((raw: unknown) => {
      let request: PendingRequest;
      try {
        request = decodeHostAnswer(PendingRequest)(raw);
      } catch {
        return [];
      }
      return [
        {
          threadId: String(request.threadId),
          threadTitle: request.threadTitle,
          mode: request.mode,
          kind: request.kind,
          ...("text" in request && typeof request.text === "string" ? { text: request.text } : {}),
          waitingSince: String(request.requestedAt),
          answerableHere:
            request.kind === "lead-question" ||
            (request.mode === "chat" && request.kind === "question"),
        },
      ];
    }),
  };
}

/**
 * Everything waiting on the person across the host, oldest first. A fresh
 * window sees Chat and nothing scoped to a Project, so each active Work and
 * Code Project is opened in turn and its rows merged. `complete` is false
 * when any read failed or the host held more than it returned.
 */
export async function listWaitingRequests(session: OpenedLocalControlSession): Promise<
  | HostRefusal
  | {
      readonly kind: "read";
      readonly requests: ReadonlyArray<AgentWaitingRequest>;
      readonly complete: boolean;
    }
> {
  const projects = await readActiveProjects(session);
  if (projects.kind === "refused") return projects;
  const first = await readWaitingRows(session);
  if (first.kind === "refused") return first;
  const found = new Map<string, AgentWaitingRequest>();
  let complete = true;
  const take = (read: WaitingRead) => {
    if (read.kind === "refused" || read.truncated) complete = false;
    if (read.kind === "refused") return;
    for (const request of read.requests) {
      found.set(
        JSON.stringify([request.threadId, request.kind, request.text, request.waitingSince]),
        request,
      );
    }
  };
  take(first);
  for (const project of projects.active) {
    if (project.type !== "work" && project.type !== "code") continue;
    const opened = await openAgentWindow(session, {
      mode: project.type,
      projectId: String(project.id),
      projectName: project.name,
    });
    if (opened.kind === "refused") {
      complete = false;
      continue;
    }
    take(await readWaitingRows(session));
  }
  return {
    kind: "read",
    complete,
    requests: [...found.values()].toSorted((a, b) => a.waitingSince.localeCompare(b.waitingSince)),
  };
}

/**
 * What waits on the person for this thread, read in the window that has the
 * thread's Project open. A harness question and a Chat turn's question are
 * left out: they are listed as open questions instead. A failed or cut-off
 * read is reported as incomplete, never as nothing waiting.
 */
async function personRequests(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<{ readonly requests: ReadonlyArray<AgentPersonRequest>; readonly complete: boolean }> {
  const listed = await readWaitingRows(session);
  if (listed.kind === "refused") {
    // The Needs you list answers local windows only. A caller that is not one
    // (an outside agent) still learns of the agent's own pending approvals
    // from the thread's harness session, and the list stays marked incomplete.
    return { requests: await harnessApprovals(session, threadId), complete: false };
  }
  return {
    complete: !listed.truncated,
    requests: listed.requests.flatMap((request) =>
      request.threadId !== threadId || request.answerableHere
        ? []
        : [{ kind: request.kind, ...(request.text === undefined ? {} : { text: request.text }) }],
    ),
  };
}

async function harnessApprovals(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<ReadonlyArray<AgentPersonRequest>> {
  const response = await session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) return [];
  const view = (response.body as { readonly view?: unknown } | undefined)?.view;
  if (view === null || view === undefined) return [];
  return (decodeHostAnswer(NativeHarnessSessionView)(view).approvals ?? [])
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({ kind: "lead-approval", text: approval.summary }));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
