import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId } from "@octant/contracts";
import { AgentRunChildCodeThreads } from "./agentRunChildCodeThreads";
import {
  childDebugTools,
  childLanguageTools,
  childTerminalTools,
  type ChildCodeToolInput,
} from "./agentRunChildCodeTools";
import { AgentRunChildResources } from "./agentRunChildTools";
import { CHILD_PARENT, CHILD_RUN, childHost } from "./agentRunChildTools.test-support";

const PARENT_CHECKOUT = "44444444-4444-4444-8444-444444444444";
const REPOSITORY = "88888888-8888-4888-8888-888888888888";
let root: string;

const parent = {
  id: CHILD_PARENT,
  projectId: "77777777-7777-4777-8777-777777777777",
  bindingRevisionId: "60000000-0000-4000-8000-000000000001",
  repositoryId: REPOSITORY,
  checkoutId: PARENT_CHECKOUT,
  title: "Footer work",
  lifecycle: "active",
  executionPolicy: "full-access",
  permissionPersistence: "project-default",
  providerInstanceId: "99999999-9999-4999-8999-999999999999",
  modelId: "lead-model",
  deliveryTarget: { proposedBaseRepository: "octant/octant" },
} as never;
const checkout = {
  id: PARENT_CHECKOUT,
  repositoryId: REPOSITORY,
  kind: "existing-worktree",
  availability: "available",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  observedAt: "2026-10-03T00:00:00.000Z",
} as never;

function threadsFor(owned = true) {
  return new AgentRunChildCodeThreads({
    readThread: (id) => (String(id) === CHILD_PARENT ? parent : undefined),
    readCheckout: () => checkout,
    verifiedHead: async () => (owned ? "a".repeat(40) : undefined),
    fileId: () => crypto.randomUUID() as never,
  });
}

function input(
  overrides: Parameters<typeof childHost>[0] = {},
  threads = threadsFor(),
): ChildCodeToolInput {
  return {
    host: childHost({ root, ...overrides }),
    threads,
    resources: new AgentRunChildResources(),
    hostId: "30000000-0000-4000-8000-000000000001" as never,
    externalContentIngested: () => false,
    recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }) as never,
    uuid: () => crypto.randomUUID(),
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "octant-child-code-")));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const call = (name: string, body: unknown) => ({ name, inputJson: JSON.stringify(body) });

describe("a Code child's own thread", () => {
  it("is the child's run in its own worktree at its own level, never its parent's", async () => {
    const threads = threadsFor();
    const host = childHost({ root });
    const child = threads.read(host);
    expect(String(child?.thread.id)).toBe(CHILD_RUN);
    expect(String(child?.checkout.id)).not.toBe(PARENT_CHECKOUT);
    expect(child?.thread.executionPolicy).toBe("approval-gated");
    expect(child?.thread.modelId).toBe("worker-model");
    expect(child?.folder).toBe(root);
    if (child === undefined) throw new Error("Expected a child thread.");
    // Nothing can name it until a child's tool holds it, and nothing after.
    expect(threads.readThread(decodeCodeThreadId(CHILD_RUN))).toBeUndefined();
    const release = threads.hold(host);
    expect(threads.readThread(decodeCodeThreadId(CHILD_RUN))).toBeDefined();
    expect(threads.parentOf(CHILD_RUN)).toBe(CHILD_PARENT);
    expect((await threads.resolveRoot(child.thread, "a.ts" as never))?.rootPath).toBe(root);
    expect(await threads.resolveRoot(child.thread, "/etc/passwd" as never)).toBeUndefined();
    release();
    expect(threads.readThread(decodeCodeThreadId(CHILD_RUN))).toBeUndefined();
  });

  it("reads as gone once the child loses its grant, and has no root its run does not own", async () => {
    let held = true;
    const threads = threadsFor(false);
    const host = childHost({ root, current: () => held });
    const child = threads.read(host);
    if (child === undefined) throw new Error("Expected a child thread.");
    threads.hold(host);
    expect(await threads.resolveRoot(child.thread, "a.ts" as never)).toBeUndefined();
    held = false;
    expect(threads.readThread(decodeCodeThreadId(CHILD_RUN))).toBeUndefined();
    expect(threads.readThreads()).toEqual([]);
  });

  it("exists only in Code", () => {
    expect(threadsFor().read(childHost({ mode: "work", root }))).toBeUndefined();
    expect(threadsFor().read(childHost({ mode: "chat" }))).toBeUndefined();
  });
});

describe("a Code child's language reads", () => {
  const language = (serves = true) => ({
    servesAgentsIn: vi.fn((_folders: ReadonlyArray<string>, _turn?: unknown) => serves),
    readForAgent: vi.fn(async (_window: unknown, _request: unknown) => ({
      status: "diagnostics" as const,
      diagnostics: [],
      truncated: false,
    })),
    sweep: vi.fn(async () => undefined),
  });

  it("are offered where a server covers the child's worktree, Plan included, and nowhere else", () => {
    const serving = language();
    expect(childLanguageTools({ ...input(), language: serving as never })).toBeDefined();
    expect(serving.servesAgentsIn.mock.calls[0]?.[0]).toEqual([root]);
    expect(
      childLanguageTools({ ...input({ policy: "plan" }), language: language() as never }),
    ).toBeDefined();
    expect(childLanguageTools({ ...input(), language: language(false) as never })).toBeUndefined();
    expect(
      childLanguageTools({ ...input({ mode: "work" }), language: language() as never }),
    ).toBeUndefined();
  });

  it("name the child's own thread and checkout, and stop its servers when the run ends", async () => {
    const serving = language();
    const tools = childLanguageTools({ ...input(), language: serving as never });
    const answer = await tools?.execute(
      call("octant_code", { operation: "diagnostics", path: "a.ts" }),
    );
    expect(answer?.isError).toBe(false);
    expect(serving.readForAgent.mock.calls[0]?.[1]).toMatchObject({ threadId: CHILD_RUN });
    expect(serving.readForAgent.mock.calls[0]?.[1]).not.toMatchObject({
      checkoutId: PARENT_CHECKOUT,
    });
    await tools?.close?.();
    expect(serving.sweep).toHaveBeenCalledTimes(1);
  });
});

describe("a Code child's terminal", () => {
  function service() {
    let running = false;
    let marker = "";
    const snapshot = () => ({
      terminalId: "t",
      status: running ? ("running" as const) : ("interrupted" as const),
      canRerun: true,
      transcript: {
        chunks: [marker === "" ? "" : `done\u001b]777;octant=${marker};exit=0\u0007`],
        byteLength: 4,
        truncated: false,
        characters: 4,
      },
    });
    return {
      launch: vi.fn(async (_request: unknown) => {
        running = true;
        return snapshot();
      }),
      attach: vi.fn(snapshot),
      write: vi.fn((_id: string, data: string) => {
        marker = /octant=(oo\w+)/.exec(data)?.[1] ?? "";
      }),
      terminate: vi.fn(async () => {
        running = false;
        return snapshot();
      }),
    };
  }
  const launchFor = ({ folder, executionPolicy }: { folder: string; executionPolicy: string }) => ({
    shell: "/bin/zsh",
    cwd: folder,
    stateScope: REPOSITORY,
    executionPolicy: executionPolicy as never,
  });

  it("is offered outside Plan where a person can answer, and refused under a routine", () => {
    const offered = (overrides: Parameters<typeof childHost>[0]) =>
      childTerminalTools({ ...input(overrides), terminals: service() as never, launchFor });
    expect(offered({})).toBeDefined();
    expect(offered({ policy: "plan" })).toBeUndefined();
    expect(offered({ attended: false })).toBeUndefined();
    expect(offered({ mode: "work" })).toBeUndefined();
    expect(offered({ mode: "chat" })).toBeUndefined();
  });

  it("asks before each command below Full access and runs it in the child's own worktree", async () => {
    const terminals = service();
    let answer: "approved" | "denied" = "denied";
    const ask = vi.fn(async (_input: { readonly summary: string }) => answer);
    const tools = childTerminalTools({
      ...input({ ask }),
      terminals: terminals as never,
      launchFor,
    });
    const run = call("octant_terminal", { operation: "run", command: "bun run dev" });
    expect(await tools?.execute(run)).toMatchObject({
      isError: true,
      result: { error: "terminal-approval-denied" },
    });
    expect(terminals.launch).not.toHaveBeenCalled();
    answer = "approved";
    expect((await tools?.execute(run))?.isError).toBe(false);
    expect(ask.mock.calls[0]?.[0].summary).toContain("bun run dev");
    expect(terminals.launch.mock.calls[0]?.[0]).toMatchObject({
      cwd: root,
      executionPolicy: "approval-gated",
      credentialReferences: [],
    });
    await tools?.execute(run);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("asks nothing at Full access, and stops its shell when the run ends", async () => {
    const terminals = service();
    const ask = vi.fn(async () => "approved" as const);
    const tools = childTerminalTools({
      ...input({ policy: "full-access", ask }),
      terminals: terminals as never,
      launchFor,
    });
    await tools?.execute(call("octant_terminal", { operation: "run", command: "ls" }));
    expect(ask).not.toHaveBeenCalled();
    expect(terminals.terminate).not.toHaveBeenCalled();
    await tools?.close?.();
    expect(terminals.terminate).toHaveBeenCalledTimes(1);
  });

  it("starts nothing in a worktree its run no longer owns", async () => {
    const terminals = service();
    const tools = childTerminalTools({
      ...input({ policy: "full-access" }, threadsFor(false)),
      terminals: terminals as never,
      launchFor,
    });
    expect(
      await tools?.execute(call("octant_terminal", { operation: "run", command: "ls" })),
    ).toMatchObject({ isError: true });
    expect(terminals.launch).not.toHaveBeenCalled();
  });

  it("stops its shell when its parent leaves it nothing to act under", async () => {
    let held = true;
    const terminals = service();
    const child = input({ policy: "full-access", current: () => held });
    const tools = childTerminalTools({ ...child, terminals: terminals as never, launchFor });
    await tools?.execute(call("octant_terminal", { operation: "run", command: "ls" }));
    held = false;
    await child.resources.settle();
    expect(terminals.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("a Code child's debugger", () => {
  const debug = () => ({
    offersSessions: vi.fn(() => true),
    configurations: vi.fn(async () => ({
      status: "listed" as const,
      approved: [],
      launchFile: { status: "absent" as const },
      session: undefined,
    })),
    start: vi.fn(),
    session: vi.fn(),
    threadSession: vi.fn((_caller: unknown, _scope: unknown) => ({ status: "none" as const })),
    endThread: vi.fn(async (_thread: unknown) => undefined),
  });

  it("is offered outside Plan where a person can answer, and nowhere else", () => {
    const offered = (overrides: Parameters<typeof childHost>[0]) =>
      childDebugTools({ ...input(overrides), debug: debug() as never });
    expect(offered({})).toBeDefined();
    expect(offered({ policy: "plan" })).toBeUndefined();
    expect(offered({ attended: false })).toBeUndefined();
    expect(offered({ mode: "work" })).toBeUndefined();
  });

  it("acts on the child's own thread, and ends its sessions when the run ends", async () => {
    const service = debug();
    const tools = childDebugTools({ ...input(), debug: service as never });
    await tools?.execute(call("octant_debug", { operation: "configurations" }));
    expect(service.threadSession.mock.calls[0]?.[1]).toMatchObject({ threadId: CHILD_RUN });
    await tools?.close?.();
    expect(service.endThread).toHaveBeenCalledWith(CHILD_RUN);
  });
});
