import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentThreads from "./agentThread";
import { runAgentMcpServer } from "./agentMcpServer";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const now = "2026-11-11T09:00:00.000Z";
const projectId = "20000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000001";
const repo = realpathSync(mkdtempSync(join(tmpdir(), "octant-mcp-repo-")));
mkdirSync(join(repo, "src"));
const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "octant-mcp-elsewhere-")));

function codeProject(): unknown {
  return {
    id: projectId,
    name: "Repo",
    type: "code",
    lifecycle: "active",
    pinned: false,
    rank: "1/2",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: repo },
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    codeAccessPersistence: "current-session",
  };
}

type Turn = agentThreads.AgentThreadSnapshot["turns"][number];

/** A thread whose turns the test moves along; `send` adds the new one. */
function thread(mode: "chat" | "code", options: { readonly sendAnswers?: Promise<void> } = {}) {
  const turns: Turn[] = [];
  const sent: string[] = [];
  const port: agentThreads.AgentThreadPort = {
    mode,
    threadId,
    read: async () => ({
      id: threadId,
      mode,
      title: "Fix the flaky test",
      providerInstanceId: "provider",
      modelId: "model",
      version: 1,
      workItems: [],
      turns: [...turns],
    }),
    send: async (prompt) => {
      sent.push(prompt);
      turns.push({
        id: `turn-${turns.length + 1}`,
        at: now,
        prompt,
        reply: "",
        replyAt: now,
        outcome: "streaming",
      });
      await options.sendAnswers;
      return { kind: "sent" };
    },
    interrupt: async () => ({ kind: "interrupted" }),
  };
  const finish = (reply: string) => {
    const last = turns.at(-1);
    if (last !== undefined) turns[turns.length - 1] = { ...last, reply, outcome: "completed" };
  };
  return { port, sent, finish };
}

/** A host session answering the routes the server reads beside the stubbed thread port. */
function host(
  options: {
    readonly projects?: ReadonlyArray<unknown>;
    readonly pending?: ReadonlyArray<unknown>;
    readonly harnessQuestions?: ReadonlyArray<unknown>;
  } = {},
) {
  const seen: LocalControlRequest[] = [];
  let opened = 0;
  let closed = 0;
  const session = (): OpenedLocalControlSession => {
    opened += 1;
    return {
      kind: "opened",
      windowId: `window-${opened}`,
      send: async (request) => {
        seen.push(request);
        if (request.path === "/api/projects/bootstrap") {
          return {
            status: 200,
            body: { active: options.projects ?? [], archived: [], availability: [], memory: [] },
          };
        }
        if (request.path === "/api/pending-requests") {
          return { status: 200, body: { requests: options.pending ?? [], truncated: false } };
        }
        if (request.path === `/api/native-harness/sessions/${threadId}`) {
          return {
            status: 200,
            body: {
              view:
                options.harnessQuestions === undefined
                  ? null
                  : harnessView(options.harnessQuestions),
            },
          };
        }
        if (request.path === `/api/native-harness/sessions/${threadId}/questions`) {
          return { status: 200, body: {} };
        }
        if (request.path === "/api/desktop/project-binding-receipts") {
          return { status: 201, body: { receiptId: "receipt-1" } };
        }
        if (request.path === "/api/projects/commands") return { status: 200, body: {} };
        return { status: 404, body: { message: `Unexpected ${request.method} ${request.path}` } };
      },
      close: async () => {
        closed += 1;
      },
    };
  };
  return {
    openSession: async () => session(),
    seen,
    opened: () => opened,
    closed: () => closed,
  };
}

function harnessView(questions: ReadonlyArray<unknown>): unknown {
  return {
    session: {
      id: "70000000-0000-4000-8000-000000000001",
      threadId,
      mode: "work",
      leadSlotId: "default",
      lead: {
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "frontier-large",
      },
      status: "running",
      turnsRun: 1,
      cutovers: 0,
      startedAt: now,
      updatedAt: now,
      version: 1,
    },
    routes: [],
    turns: [],
    reductions: [],
    interventions: [],
    activatedFollowUpIds: [],
    questions,
  };
}

/** Drives the server over its stdio framing, one request at a time. */
function serve(fake: ReturnType<typeof host>) {
  const input = new PassThrough();
  const lines: string[] = [];
  let buffered = "";
  const waiters: Array<() => void> = [];
  const stdout = {
    write: (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        lines.push(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
      }
      for (const wake of waiters.splice(0)) wake();
    },
  };
  const done = runAgentMcpServer({
    openSession: fake.openSession,
    input,
    stdout,
    stderr: { write: () => undefined },
    version: "test",
    pollIntervalMs: 1,
  });
  let nextId = 1;
  const request = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (;;) {
      const found = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((message) => message["id"] === id);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await request("tools/call", { name, arguments: args });
    const result = answer["result"] as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? "";
    return {
      isError: result.isError === true,
      text,
      value: (() => {
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })(),
    };
  };
  const end = async () => {
    input.end();
    return await done;
  };
  return { request, call, end };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("octant agent mcp", () => {
  it("introduces itself and lists its tools over the stdio framing", async () => {
    const server = serve(host());
    const initialized = await server.request("initialize", { protocolVersion: "2025-06-18" });
    expect(initialized["result"]).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "octant" },
    });
    const listed = await server.request("tools/list");
    const names = (listed["result"] as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["start_work", "send_message", "read_thread", "answer_question"]),
    );
    expect((await server.request("resources/list"))["error"]).toMatchObject({ code: -32601 });
    expect(await server.end()).toBe(0);
  });

  it("starts work in the Project holding the folder and answers once the turn has started", async () => {
    const fake = host({ projects: [codeProject()] });
    const work = thread("code");
    const create = vi.spyOn(agentThreads, "createAgentThread").mockResolvedValue({
      kind: "created",
      threadId,
      mode: "code",
      projectName: "Repo",
    });
    vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue(work.port);
    const server = serve(fake);

    const started = await server.call("start_work", {
      prompt: "Fix the flaky test\nIt fails on CI only.",
      folder: join(repo, "src"),
    });

    expect(started.isError).toBe(false);
    expect(started.value).toMatchObject({
      threadId,
      mode: "code",
      project: "Repo",
      status: "running",
    });
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "auto",
        cwd: join(repo, "src"),
        title: "Fix the flaky test",
      }),
    );
    expect(work.sent).toEqual(["Fix the flaky test\nIt fails on CI only."]);
    await server.end();
    // Every call's window authority is revoked once the call has finished.
    expect(fake.closed()).toBe(fake.opened());
  });

  it("adds a folder as a Project only when the caller says the person asked to work there", async () => {
    const fake = host({ projects: [] });
    const create = vi.spyOn(agentThreads, "createAgentThread").mockResolvedValue({
      kind: "created",
      threadId,
      mode: "code",
      projectName: "Elsewhere",
    });
    vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue(thread("code").port);
    const server = serve(fake);

    const refused = await server.call("start_work", { prompt: "Fix it", folder: elsewhere });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("addProject: true");
    expect(create).not.toHaveBeenCalled();
    expect(fake.seen.some((request) => request.path.includes("project-binding"))).toBe(false);

    const added = await server.call("start_work", {
      prompt: "Fix it",
      folder: elsewhere,
      addProject: true,
    });
    expect(added.isError).toBe(false);
    expect(
      fake.seen.find((request) => request.path.includes("project-binding"))?.body,
    ).toMatchObject({ projectType: "code", path: elsewhere });
    expect(
      fake.seen.find((request) => request.path === "/api/projects/commands")?.body,
    ).toMatchObject({ kind: "create-code-project" });
    expect(create).toHaveBeenCalledTimes(1);
    await server.end();
  });

  it("never starts a thread at Full access, and says the person turns it on", async () => {
    const fake = host({ projects: [codeProject()] });
    const create = vi.spyOn(agentThreads, "createAgentThread");
    const server = serve(fake);

    const refused = await server.call("start_work", {
      prompt: "Fix it",
      folder: repo,
      access: "full-access",
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("only turned on by the person in Octant");
    expect(create).not.toHaveBeenCalled();
    expect(fake.opened()).toBe(0);
    await server.end();
  });

  it("answers the thread's question but lists its approval as the person's to answer in Octant", async () => {
    const fake = host({
      harnessQuestions: [
        {
          id: "80000000-0000-4000-8000-000000000001",
          prompt: "Which test runner?",
          options: ["vitest", "bun"],
          status: "pending",
          askedAt: now,
        },
      ],
      pending: [
        {
          mode: "work",
          kind: "lead-approval",
          projectId,
          threadId,
          threadTitle: "Fix the flaky test",
          requestedAt: now,
          text: "Run the full test suite",
        },
      ],
    });
    vi.spyOn(agentThreads, "openAgentThreadById").mockResolvedValue({
      kind: "opened",
      mode: "work",
      projectName: "Repo",
    });
    const work = thread("code");
    await work.port.send("Fix the flaky test");
    vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue(work.port);
    const server = serve(fake);

    const read = await server.call("read_thread", { threadId });
    expect(read.value).toMatchObject({
      status: "waiting-for-answer",
      questions: [
        {
          questionId: "80000000-0000-4000-8000-000000000001",
          prompt: "Which test runner?",
          options: ["vitest", "bun"],
        },
      ],
      waitingInOctant: [{ kind: "lead-approval", text: "Run the full test suite" }],
    });

    const waiting = await server.call("list_waiting", {});
    expect(waiting.value).toEqual({
      waiting: [
        {
          threadId,
          threadTitle: "Fix the flaky test",
          mode: "work",
          kind: "lead-approval",
          text: "Run the full test suite",
          waitingSince: now,
          answerableHere: false,
        },
      ],
    });

    const approval = await server.call("answer_question", {
      threadId,
      questionId: "approval-1",
      answer: "yes",
    });
    expect(approval.isError).toBe(true);
    expect(approval.text).toContain("answered by the person in Octant");
    expect(fake.seen.some((request) => request.path.endsWith("/approvals"))).toBe(false);

    const answered = await server.call("answer_question", {
      threadId,
      questionId: "80000000-0000-4000-8000-000000000001",
      answer: "vitest",
    });
    expect(answered.isError).toBe(false);
    expect(fake.seen.find((request) => request.path.endsWith("/questions"))?.body).toEqual({
      questionId: "80000000-0000-4000-8000-000000000001",
      answer: "vitest",
    });
    await server.end();
  });

  it("waits for the turn to end when asked and answers with the reply", async () => {
    const fake = host();
    vi.spyOn(agentThreads, "openAgentThreadById").mockResolvedValue({
      kind: "opened",
      mode: "code",
      projectName: "Repo",
    });
    const work = thread("code");
    const reads = work.port.read;
    let count = 0;
    vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue({
      ...work.port,
      read: async () => {
        count += 1;
        if (count === 6) work.finish("Fixed: the test now waits for the server.");
        return await reads();
      },
    });
    const server = serve(fake);

    const followed = await server.call("send_message", {
      threadId,
      prompt: "Now fix it",
      wait: true,
    });

    expect(followed.value).toMatchObject({
      status: "idle",
      turns: [{ outcome: "completed", reply: "Fixed: the test now waits for the server." }],
    });
    await server.end();
  });

  it("keeps a Chat send's window open until the send answers, which is when its turn ends", async () => {
    const fake = host();
    const sendAnswers = Promise.withResolvers<void>();
    const chat = thread("chat", { sendAnswers: sendAnswers.promise });
    vi.spyOn(agentThreads, "createAgentThread").mockResolvedValue({
      kind: "created",
      threadId,
      mode: "chat",
    });
    vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue(chat.port);
    const server = serve(fake);

    const started = await server.call("start_work", { prompt: "What changed in Octant today?" });
    expect(started.value).toMatchObject({ mode: "chat", status: "running" });
    expect(fake.closed()).toBe(0);

    sendAnswers.resolve();
    await vi.waitFor(() => expect(fake.closed()).toBe(1));
    await server.end();
  });
});
