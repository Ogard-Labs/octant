import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActorId,
  ReplayCursor,
  decodeBrowserThreadId,
  decodeCodeTerminalId,
  decodeCodeThreadId,
  decodeWindowId,
  type BrowserThreadId,
  type CodeThread,
  type ToolActionAuthority,
} from "@octant/contracts";
import { runMcpCommand } from "@octant/cli/mcp";
import { Schema } from "effect";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomationService } from "../browser/browserAutomationService";
import type { BrowserRuntimePort } from "../browser/browserRuntimePort";
import { BrowserToolApprovalService } from "../browser/browserToolApprovalService";
import { Journal } from "../persistence/journal";
import { TerminalService } from "./terminalService";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  TerminalBrowserGrantService,
  type TerminalBrowserGrantOpening,
  type TerminalBrowserGrantServiceOptions,
} from "./terminalBrowserGrantService";

const now = "2026-10-13T09:00:00.000Z";
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const ids = {
  actor: "90000000-0000-4000-8000-000000000001",
  host: "90000000-0000-4000-8000-000000000002",
  project: "90000000-0000-4000-8000-000000000003",
  otherProject: "90000000-0000-4000-8000-000000000004",
  provider: "90000000-0000-4000-8000-000000000005",
  checkout: "90000000-0000-4000-8000-000000000006",
  threadA: "a0000000-0000-4000-8000-000000000001",
  threadB: "a0000000-0000-4000-8000-000000000002",
  window: "b0000000-0000-4000-8000-000000000001",
  otherWindow: "b0000000-0000-4000-8000-000000000002",
  terminalA: "c0000000-0000-4000-8000-000000000001",
  terminalB: "c0000000-0000-4000-8000-000000000002",
} as const;
const personActor = {
  kind: "local-user",
  actorId: Schema.decodeUnknownSync(ActorId)(ids.actor),
} as const;
const hostActor = {
  kind: "system",
  actorId: Schema.decodeUnknownSync(ActorId)(ids.actor),
} as const;
const windowId = decodeWindowId(ids.window);
const terminalA = decodeCodeTerminalId(ids.terminalA);
const terminalB = decodeCodeTerminalId(ids.terminalB);
const threadA = decodeCodeThreadId(ids.threadA);
const threadB = decodeCodeThreadId(ids.threadB);

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function codeThread(id: string, overrides: Partial<CodeThread> = {}): CodeThread {
  return {
    id,
    checkoutId: ids.checkout,
    projectId: ids.project,
    repositoryId: "90000000-0000-4000-8000-000000000007",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    bindingRevisionId: "90000000-0000-4000-8000-000000000008",
    lifecycle: "active",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    title: "Thread",
    workingDirectory: ".",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as CodeThread;
}

function authorityFor(): ToolActionAuthority {
  return {
    hostId: ids.host,
    mode: "code",
    projectId: ids.project,
    rootId: "90000000-0000-4000-8000-000000000009",
    worktreeId: ids.checkout,
    providerInstanceId: ids.provider,
    extension: { kind: "core" },
  } as unknown as ToolActionAuthority;
}

interface HarnessOptions {
  readonly threads?: ReadonlyArray<CodeThread>;
  readonly lendsBrowser?: boolean;
  readonly canAccess?: (window: string, project: string) => boolean;
}

function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-terminal-browser-grant-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtimeRegistries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtimeRegistries.events,
    projections: runtimeRegistries.projections,
    clock: () => now,
  });
  const threads = new Map<string, CodeThread>(
    (options.threads ?? [codeThread(ids.threadA)]).map((thread) => [String(thread.id), thread]),
  );
  const running = new Set<string>([ids.terminalA, ids.terminalB]);
  const contexts = new Set<string>();
  const runtime: BrowserRuntimePort = {
    available: vi.fn(async () => true),
    createContext: vi.fn(async (contextId) => void contexts.add(String(contextId))),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async (_contextId, input) => ({
      url: input.target ?? "https://example.com/start",
      title: "Example",
      extractedText: "Readable page text",
      contentHash: "a".repeat(64),
      screenshotDataUrl: "data:image/png;base64,AAAA",
    })),
    peek: vi.fn(async () => ({ url: "https://example.com/start", title: "Example" })),
    closeContext: vi.fn(async (contextId) => void contexts.delete(String(contextId))),
    closeAll: vi.fn(async () => contexts.clear()),
    onProcessExit: () => () => undefined,
  };
  const recordExternalContentIngestion = vi.fn(() => ({
    kind: "recorded" as const,
    taint: { externalContentIngested: true } as never,
  }));
  const captures = {
    keep: vi.fn(async () => ({ status: "not-kept", reason: "unavailable" }) as never),
  };
  let uuidCounter = 0;
  const uuid = () => `d0000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;
  const authority = {
    resolve: (threadId: BrowserThreadId) =>
      threads.has(String(threadId)) && threads.get(String(threadId))?.lifecycle === "active"
        ? authorityFor()
        : undefined,
    canAccessWindow: () => true,
  };
  const browser = new BrowserAutomationService({
    runtime,
    authority,
    recordExternalContentIngestion,
    captures,
    uuid,
    clock: () => now,
    now: () => Date.parse(now),
    schedule: () => () => undefined,
  });
  const approvals = new BrowserToolApprovalService({
    uuid,
    now: () => Date.parse(now),
    authorityIsCurrent: () => true,
  });
  const createSpy = vi.spyOn(browser, "create");
  const actSpy = vi.spyOn(browser, "act");
  const serviceOptions: TerminalBrowserGrantServiceOptions = {
    readThread: (threadId) => threads.get(String(threadId)),
    canAccessProject: (window, project) =>
      options.canAccess?.(String(window), String(project)) ?? String(window) === ids.window,
    terminalIsRunning: (terminalId) => running.has(String(terminalId)),
    ...(options.lendsBrowser === false
      ? {}
      : {
          browser: {
            resolveAuthority: (threadId) => authority.resolve(threadId),
            automation: {
              inspectThread: (window, threadId) => browser.inspectThread(window, threadId),
              create: (command) => browser.create(command),
              act: (command) => browser.act(command),
              releaseThread: (window, threadId) => browser.releaseThread(window, threadId),
            },
            approvals,
          },
        }),
    journal,
    personActor,
    hostActor,
    uuid,
    clock: () => now,
  };
  const service = new TerminalBrowserGrantService(serviceOptions);
  cleanups.push(() => service.close());
  const grantEvents = () =>
    journal
      .replay(decodeReplayCursor({ afterSequence: 0, limit: 100 }))
      .filter((event) => event.aggregateType === "terminal-browser-grant");
  return {
    service,
    threads,
    running,
    runtime,
    approvals,
    captures,
    createSpy,
    actSpy,
    recordExternalContentIngestion,
    grantEvents,
    journal,
  };
}

type Harness = ReturnType<typeof harness>;

async function open(
  fixture: Harness,
  overrides: Partial<Parameters<Harness["service"]["open"]>[0]> = {},
) {
  return fixture.service.open({
    caller: "local-window",
    windowId,
    threadId: threadA,
    terminalId: terminalA,
    ...overrides,
  });
}

/** What the terminal's shell would find in its environment. */
function environmentOf(fixture: Harness, opening: TerminalBrowserGrantOpening) {
  if (opening.kind !== "granted") throw new Error("Expected a granted opening.");
  const environment: Record<string, string> = {};
  for (const credential of opening.credentialReferences) {
    const value = fixture.service.resolveReference(credential.reference);
    if (value === undefined) throw new Error("Expected the reference to resolve.");
    environment[credential.environmentName] = value;
  }
  return {
    url: environment["OCTANT_BROWSER_MCP_URL"] ?? "",
    token: environment["OCTANT_BROWSER_MCP_TOKEN"] ?? "",
  };
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

async function rpcJson(response: Response): Promise<{
  readonly result?: { readonly content?: ReadonlyArray<{ readonly text?: string }> };
  readonly [key: string]: unknown;
}> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as never;
  }
  const payload = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .at(-1);
  if (payload === undefined) throw new Error("MCP response carried no payload.");
  return JSON.parse(payload) as never;
}

/** A provider CLI's MCP client, as far as this endpoint can tell. */
async function connect(url: string, token: string) {
  const base = { ...MCP_HEADERS, authorization: `Bearer ${token}` };
  const initialize = await fetch(url, {
    method: "POST",
    headers: base,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "typed-cli", version: "1" },
      },
    }),
  });
  const sessionId = initialize.headers.get("mcp-session-id");
  await initialize.text();
  if (sessionId === null) throw new Error("The endpoint did not open a session.");
  const headers = { ...base, "mcp-session-id": sessionId };
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
  let id = 10;
  return {
    bodies: [] as string[],
    async list() {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
      });
      return rpcJson(response);
    },
    async call(args: Readonly<Record<string, unknown>>) {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: "octant_browser", arguments: args },
        }),
      });
      const text = await response.clone().text();
      this.bodies.push(text);
      const rpc = await rpcJson(response);
      const first = (rpc.result as { content?: Array<{ text?: string }> } | undefined)
        ?.content?.[0];
      const isError = (rpc.result as { isError?: boolean } | undefined)?.isError === true;
      return {
        isError,
        data: first?.text === undefined ? undefined : (JSON.parse(first.text) as unknown),
      };
    },
  };
}

/** Answer the next approval the person is shown in the window, as the person would. */
async function approveNext(fixture: Harness, decision: "approved" | "denied" = "approved") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [pending] = fixture.approvals.list(windowId);
    if (pending !== undefined) {
      fixture.approvals.decide(windowId, { approvalId: pending.approvalId, decision });
      return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No approval was raised.");
}

function skipWithoutLoopback(error: unknown, context: { skip: (note: string) => void }): boolean {
  if (error instanceof Error && error.message.includes("EPERM")) {
    context.skip("the test sandbox does not permit loopback listeners");
    return true;
  }
  return false;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("terminal Browser grant", () => {
  it("mints a grant for the person's own thread terminal and starts it with two OCTANT variables", async (context) => {
    const fixture = harness();
    let opening: TerminalBrowserGrantOpening;
    try {
      opening = await open(fixture);
    } catch (error) {
      if (skipWithoutLoopback(error, context)) return;
      throw error;
    }
    if (opening.kind === "refused" && opening.outcome.reason === "grant-unavailable") {
      context.skip("the test sandbox does not permit loopback listeners");
      return;
    }
    expect(opening).toMatchObject({
      kind: "granted",
      outcome: { status: "granted", threadId: ids.threadA, terminalId: ids.terminalA },
    });
    if (opening.kind !== "granted") return;
    expect(opening.credentialReferences.map((credential) => credential.environmentName)).toEqual([
      "OCTANT_BROWSER_MCP_URL",
      "OCTANT_BROWSER_MCP_TOKEN",
    ]);
    const { url, token } = environmentOf(fixture, opening);
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(token.length).toBeGreaterThan(20);
    expect(fixture.grantEvents().map((event) => event.eventName)).toEqual([
      "code.terminal-browser-grant-issued@1",
    ]);
  });

  it.each([
    ["a paired device", { caller: "remote-device" as const }, "not-local-window"],
    [
      "an unknown thread, or a Work or Chat one",
      { threadId: decodeCodeThreadId(ids.otherWindow) },
      "not-a-code-thread",
    ],
    [
      "a window that cannot open the thread",
      { windowId: decodeWindowId(ids.otherWindow) },
      "window-cannot-open-thread",
    ],
  ])("mints nothing for %s", async (_name, overrides, reason) => {
    const fixture = harness();
    const opening = await open(fixture, overrides);
    expect(opening).toEqual({ kind: "refused", outcome: { status: "refused", reason } });
    expect(fixture.grantEvents()).toEqual([]);
    expect(fixture.service.resolveReference("terminal-browser-grant:x:endpoint")).toBeUndefined();
  });

  it.each([
    ["archived", { lifecycle: "archived" as const }],
    ["completed", { completedAt: now as never }],
  ])("mints nothing for a thread that is %s", async (_name, overrides) => {
    const fixture = harness({ threads: [codeThread(ids.threadA, overrides)] });
    expect(await open(fixture)).toEqual({
      kind: "refused",
      outcome: { status: "refused", reason: "thread-not-active" },
    });
    expect(fixture.grantEvents()).toEqual([]);
  });

  it("mints nothing when the host lends no Browser or the thread's tools exclude it", async () => {
    const withoutBrowser = harness({ lendsBrowser: false });
    expect(await open(withoutBrowser)).toEqual({
      kind: "refused",
      outcome: { status: "refused", reason: "browser-unavailable" },
    });
    const constrained = harness({
      threads: [codeThread(ids.threadA, { toolConstraints: ["octant_terminal"] } as never)],
    });
    expect(await open(constrained)).toEqual({
      kind: "refused",
      outcome: { status: "refused", reason: "browser-unavailable" },
    });
    expect(withoutBrowser.grantEvents()).toEqual([]);
    expect(constrained.grantEvents()).toEqual([]);
  });

  it("offers a running terminal one grant and refuses a second", async (context) => {
    const fixture = harness();
    const first = await open(fixture);
    if (first.kind === "refused") return void context.skip("loopback listeners are not permitted");
    expect(await open(fixture)).toEqual({
      kind: "refused",
      outcome: { status: "refused", reason: "terminal-already-granted" },
    });
  });

  it("serves exactly the Browser tool to the CLI that was started with the variables", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);
    const listed = await session.list();
    expect(
      (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    ).toEqual(["octant_browser"]);
    const help = await session.call({ operation: "help" });
    expect(help).toMatchObject({ isError: false, data: { tool: "octant_browser" } });
    expect(fixture.createSpy).not.toHaveBeenCalled();
    expect(fixture.approvals.list(windowId)).toEqual([]);
  });

  it("asks the person before the first effect on an origin and runs it as the thread", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);

    const navigating = session.call({ operation: "navigate", url: "https://example.com/docs" });
    const asked = await approveNext(fixture);
    expect(asked).toMatchObject({
      origin: "https://example.com",
      threadId: ids.threadA,
      mode: "code",
    });
    const navigated = await navigating;
    expect(navigated).toMatchObject({ isError: false, data: { status: "running" } });
    expect(fixture.createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ windowId, threadId: decodeBrowserThreadId(ids.threadA) }),
    );

    const read = await session.call({ operation: "read-page" });
    expect(read).toMatchObject({ isError: false, data: { page: { text: "Readable page text" } } });
    // The Browser service marks the thread on every page it reads, whoever asked.
    expect(fixture.recordExternalContentIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: decodeBrowserThreadId(ids.threadA) }),
    );
  });

  it("refuses the effect when the person denies the origin", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);
    const navigating = session.call({ operation: "navigate", url: "https://example.com/" });
    await approveNext(fixture, "denied");
    expect(await navigating).toMatchObject({
      isError: true,
      data: { error: "browser-approval-denied" },
    });
    expect(fixture.createSpy).not.toHaveBeenCalled();
  });

  it("does not keep a screenshot taken through the endpoint as a thread capture", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);
    const navigating = session.call({ operation: "navigate", url: "https://example.com/" });
    await approveNext(fixture);
    await navigating;
    const shot = await session.call({ operation: "screenshot" });
    expect(shot.isError).toBe(false);
    expect(fixture.actSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ capturedBy: expect.anything() }),
    );
    expect(fixture.captures.keep).not.toHaveBeenCalled();
  });

  it("refuses every effect while the thread is in Plan, without asking", async (context) => {
    const fixture = harness({ threads: [codeThread(ids.threadA, { executionPolicy: "plan" })] });
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);
    const refusedCall = await session.call({ operation: "navigate", url: "https://example.com/" });
    expect(refusedCall).toMatchObject({ isError: true, data: { error: "plan-mode-read-only" } });
    expect(fixture.approvals.list(windowId)).toEqual([]);
    expect(fixture.createSpy).not.toHaveBeenCalled();
    expect(fixture.runtime.createContext).not.toHaveBeenCalled();
  });

  it("does not run an approval answered after the thread moved into Plan", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const session = await connect(url, token);
    const navigating = session.call({ operation: "navigate", url: "https://example.com/" });
    for (
      let attempt = 0;
      attempt < 200 && fixture.approvals.list(windowId).length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fixture.threads.set(ids.threadA, codeThread(ids.threadA, { executionPolicy: "plan" }));
    await approveNext(fixture);
    expect(await navigating).toMatchObject({ isError: true });
    expect(fixture.runtime.createContext).not.toHaveBeenCalled();
  });

  describe("hostile requests", () => {
    it("answers nothing to a wrong token, a wrong path, a foreign Host, or a browser origin", async (context) => {
      const fixture = harness();
      const opening = await open(fixture);
      if (opening.kind === "refused")
        return void context.skip("loopback listeners are not permitted");
      const { url, token } = environmentOf(fixture, opening);
      const initialize = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      });
      const post = (target: string, headers: Record<string, string>) =>
        fetch(target, {
          method: "POST",
          headers: { ...MCP_HEADERS, ...headers },
          body: initialize,
        });
      expect((await post(url, { authorization: "Bearer wrong" })).status).toBe(404);
      expect((await post(url, {})).status).toBe(404);
      const wrongPath = new URL(url);
      wrongPath.pathname = "/mcp/not-the-path";
      expect((await post(wrongPath.href, { authorization: `Bearer ${token}` })).status).toBe(404);
      expect(
        (await post(url, { authorization: `Bearer ${token}`, origin: "https://example.invalid" }))
          .status,
      ).toBe(404);
      const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
        const parsed = new URL(url);
        const outgoing = httpRequest(
          {
            host: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: "POST",
            headers: {
              ...MCP_HEADERS,
              authorization: `Bearer ${token}`,
              host: `rebound.example:${parsed.port}`,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        outgoing.on("error", reject);
        outgoing.end(initialize);
      });
      expect(foreignHost).toBe(404);
      expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(200);
    });

    it("refuses a call after the person switches the grant off, and records who ended it", async (context) => {
      const fixture = harness();
      const opening = await open(fixture);
      if (opening.kind === "refused")
        return void context.skip("loopback listeners are not permitted");
      const { url, token } = environmentOf(fixture, opening);
      const session = await connect(url, token);
      expect(await session.call({ operation: "help" })).toMatchObject({ isError: false });

      const outcome = await fixture.service.switchOff({
        windowId,
        threadId: threadA,
        terminalId: terminalA,
      });
      expect(outcome).toMatchObject({ status: "revoked", reason: "switched-off" });
      await expect(session.call({ operation: "help" })).rejects.toThrow();
      await expect(connect(url, token)).rejects.toThrow();
      expect(
        fixture.service.resolveReference(opening.credentialReferences[1]?.reference ?? ""),
      ).toBeUndefined();
      expect(fixture.grantEvents().map((event) => [event.eventName, event.actor.kind])).toEqual([
        ["code.terminal-browser-grant-issued@1", "local-user"],
        ["code.terminal-browser-grant-revoked@1", "local-user"],
      ]);
      expect(
        await fixture.service.switchOff({ windowId, threadId: threadA, terminalId: terminalA }),
      ).toEqual({
        status: "refused",
        reason: "no-live-grant",
      });
    });

    it("answers a call already in flight as unauthorized once the grant is revoked", async (context) => {
      const fixture = harness();
      const opening = await open(fixture);
      if (opening.kind === "refused")
        return void context.skip("loopback listeners are not permitted");
      const { url, token } = environmentOf(fixture, opening);
      const session = await connect(url, token);
      const navigating = session
        .call({ operation: "navigate", url: "https://example.com/" })
        .catch(() => "dropped");
      for (
        let attempt = 0;
        attempt < 200 && fixture.approvals.list(windowId).length === 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await fixture.service.switchOff({ windowId, threadId: threadA, terminalId: terminalA });
      const outcome = await navigating;
      expect(outcome === "dropped" || (outcome as { isError: boolean }).isError).toBe(true);
      expect(fixture.runtime.createContext).not.toHaveBeenCalled();
    });

    it("refuses a call after the terminal closed, whether or not the host was told", async (context) => {
      const fixture = harness({ threads: [codeThread(ids.threadA), codeThread(ids.threadB)] });
      const quiet = await open(fixture);
      const told = await open(fixture, { threadId: threadB, terminalId: terminalB });
      if (quiet.kind === "refused" || told.kind === "refused") {
        return void context.skip("loopback listeners are not permitted");
      }
      const quietEnvironment = environmentOf(fixture, quiet);
      const quietSession = await connect(quietEnvironment.url, quietEnvironment.token);
      const toldEnvironment = environmentOf(fixture, told);

      fixture.running.delete(ids.terminalA);
      expect(await quietSession.call({ operation: "help" })).toMatchObject({
        isError: true,
        data: { error: "unauthorized" },
      });
      fixture.running.delete(ids.terminalB);
      fixture.service.terminalClosed(ids.terminalB);
      await expect(connect(toldEnvironment.url, toldEnvironment.token)).rejects.toThrow();
      expect(
        fixture
          .grantEvents()
          .filter((event) => event.eventName.endsWith("revoked@1"))
          .map((event) => (event.payload as { reason: string }).reason),
      ).toEqual(["terminal-closed", "terminal-closed"]);
    });

    it.for([
      ["archived", { lifecycle: "archived" as const }, "thread-archived"],
      ["completed", { completedAt: now as never }, "thread-completed"],
    ] as const)(
      "refuses a call after the thread was %s",
      async ([_name, change, reason], context) => {
        const fixture = harness();
        const opening = await open(fixture);
        if (opening.kind === "refused")
          return void context.skip("loopback listeners are not permitted");
        const { url, token } = environmentOf(fixture, opening);
        const session = await connect(url, token);
        fixture.threads.set(ids.threadA, codeThread(ids.threadA, change));
        expect(await session.call({ operation: "help" })).toMatchObject({
          isError: true,
          data: { error: "unauthorized" },
        });
        expect(
          fixture.grantEvents().map((event) => (event.payload as { reason?: string }).reason),
        ).toEqual([undefined, reason]);
      },
    );

    it("ends every grant of a thread that is archived, completed, or deleted, and of a revoked window or a stopping host", async (context) => {
      const fixture = harness({ threads: [codeThread(ids.threadA), codeThread(ids.threadB)] });
      const first = await open(fixture);
      const second = await open(fixture, { threadId: threadB, terminalId: terminalB });
      if (first.kind === "refused" || second.kind === "refused") {
        return void context.skip("loopback listeners are not permitted");
      }
      fixture.service.threadSettled(ids.threadA, "thread-deleted");
      expect(
        fixture.service.resolveReference(first.credentialReferences[0]?.reference ?? ""),
      ).toBeUndefined();
      expect(
        fixture.service.resolveReference(second.credentialReferences[0]?.reference ?? ""),
      ).toBeDefined();
      fixture.service.revokeWindow(windowId);
      expect(
        fixture.service.resolveReference(second.credentialReferences[0]?.reference ?? ""),
      ).toBeUndefined();
      const reasons = fixture
        .grantEvents()
        .filter((event) => event.eventName.endsWith("revoked@1"))
        .map((event) => [(event.payload as { reason: string }).reason, event.actor.kind]);
      expect(reasons).toEqual([
        ["thread-deleted", "system"],
        ["window-revoked", "system"],
      ]);

      const stopping = harness();
      const third = await open(stopping);
      if (third.kind === "refused") return;
      const { url, token } = environmentOf(stopping, third);
      await stopping.service.close();
      await expect(connect(url, token)).rejects.toThrow();
      expect(
        stopping.grantEvents().map((event) => (event.payload as { reason?: string }).reason),
      ).toEqual([undefined, "host-stopped"]);
    });

    it("keeps a grant for one thread from driving another thread's Browser", async (context) => {
      const fixture = harness({ threads: [codeThread(ids.threadA), codeThread(ids.threadB)] });
      const opening = await open(fixture);
      const other = await open(fixture, { threadId: threadB, terminalId: terminalB });
      if (opening.kind === "refused" || other.kind === "refused") {
        return void context.skip("loopback listeners are not permitted");
      }
      const { url, token } = environmentOf(fixture, opening);
      const otherEnvironment = environmentOf(fixture, other);
      expect(otherEnvironment.token).not.toBe(token);
      const session = await connect(url, token);
      // The other thread's token does not open this endpoint.
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { ...MCP_HEADERS, authorization: `Bearer ${otherEnvironment.token}` },
            body: "{}",
          })
        ).status,
      ).toBe(404);
      // A call cannot name another thread, and nothing it does reaches one.
      expect(
        await session.call({
          operation: "navigate",
          url: "https://example.com/",
          threadId: ids.threadB,
        }),
      ).toMatchObject({ isError: true, data: { error: "invalid-browser-input" } });
      const navigating = session.call({ operation: "navigate", url: "https://example.com/" });
      await approveNext(fixture);
      await navigating;
      expect(fixture.createSpy.mock.calls.map((call) => String(call[0].threadId))).toEqual([
        ids.threadA,
      ]);
    });
  });

  it("keeps the token and the address out of the journal, the logs, and every response body", async (context) => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        logged.push(parts.map(String).join(" "));
      });
    }
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);
    const path = new URL(url).pathname;
    const session = await connect(url, token);
    const navigating = session.call({ operation: "navigate", url: "https://example.com/" });
    await approveNext(fixture);
    await navigating;
    await session.call({ operation: "read-page" });
    await fixture.service.switchOff({ windowId, threadId: threadA, terminalId: terminalA });

    const everything = JSON.stringify([
      fixture.grantEvents().map((event) => event.payload),
      JSON.stringify(opening.outcome),
      session.bodies,
      logged,
    ]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(path);
    expect(everything).not.toContain("127.0.0.1");
  });

  it("reaches the shell only as two added variables and is redacted if the shell prints them", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const hostCredential = vi.fn(async () => "host-secret");
    let emit: (value: string) => void = () => undefined;
    const start = vi.fn(() => ({
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(async () => undefined),
      onData: vi.fn((listener: (value: string) => void) => {
        emit = listener;
        return () => undefined;
      }),
      onExit: vi.fn(() => () => undefined),
      pause: vi.fn(),
      resume: vi.fn(),
      receiptReady: Promise.resolve(),
    }));
    const terminals = new TerminalService({
      port: { start },
      inheritedEnvironment: { PATH: "/usr/bin", AWS_SECRET: "ambient" },
      credentials: {
        resolve: (reference) => fixture.service.resolveCredential(reference, hostCredential),
      },
    });
    await terminals.launch({
      terminalId: ids.terminalA,
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo",
      columns: 80,
      rows: 24,
      credentialReferences: opening.credentialReferences,
    });

    const { url, token } = environmentOf(fixture, opening);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: {
          PATH: "/usr/bin",
          OCTANT_BROWSER_MCP_URL: url,
          OCTANT_BROWSER_MCP_TOKEN: token,
        },
      }),
    );
    expect(hostCredential).not.toHaveBeenCalled();
    emit(`echo ${token} ${url}\n`);
    const printed = terminals.attach(ids.terminalA).transcript.chunks.join("");
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(new URL(url).pathname);
  });

  it("fails a launch that asks for a grant that has already ended, without asking the host", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    fixture.service.abandon(terminalA);
    const hostCredential = vi.fn(async () => "host-secret");
    for (const credential of opening.credentialReferences) {
      await expect(
        fixture.service.resolveCredential(credential.reference, hostCredential),
      ).rejects.toThrow("Credential is unavailable.");
    }
    expect(hostCredential).not.toHaveBeenCalled();
    expect(await fixture.service.resolveCredential("provider:token", hostCredential)).toBe(
      "host-secret",
    );
    expect(
      fixture.grantEvents().map((event) => (event.payload as { reason?: string }).reason),
    ).toEqual([undefined, "terminal-not-started"]);
  });

  it("reports how a grant ended when its shell never ran, and the endpoint refuses afterwards", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const { url, token } = environmentOf(fixture, opening);

    const ended = fixture.service.abandon(terminalA);

    expect(ended).toMatchObject({
      status: "revoked",
      reason: "terminal-not-started",
      terminalId: ids.terminalA,
    });
    expect(fixture.service.abandon(terminalA)).toBeUndefined();
    await expect(connect(url, token)).rejects.toThrow();
    expect(
      fixture.grantEvents().map((event) => (event.payload as { reason?: string }).reason),
    ).toEqual([undefined, "terminal-not-started"]);
  });
});

/** The two variables as the terminal's shell would hold them. */
function envOf(fixture: Harness, opening: TerminalBrowserGrantOpening) {
  const { url, token } = environmentOf(fixture, opening);
  return { OCTANT_BROWSER_MCP_URL: url, OCTANT_BROWSER_MCP_TOKEN: token };
}

/**
 * A provider CLI pointed at `octant mcp` inside the terminal: the real command
 * module, speaking stdio, against the real endpoint the grant started.
 */
function typedCli(environment: Readonly<Record<string, string>>) {
  const input = new PassThrough();
  const frames: Array<Record<string, any>> = [];
  const waiting: Array<() => void> = [];
  const stderr: string[] = [];
  let id = 0;
  const finished = runMcpCommand({
    environment,
    input,
    stdout: {
      write: (chunk) => {
        for (const line of chunk.split("\n").filter((candidate) => candidate !== "")) {
          frames.push(JSON.parse(line));
        }
        for (const wake of waiting.splice(0)) wake();
      },
    },
    stderr: { write: (chunk) => stderr.push(chunk) },
  });
  const request = async (method: string, params: unknown = {}) => {
    const requestId = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    for (;;) {
      const answer = frames.find((frame) => frame["id"] === requestId);
      if (answer !== undefined) return answer;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };
  return {
    request,
    finished,
    stderr: () => stderr.join(""),
    initialize: async () => {
      const answer = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "typed-cli", version: "1" },
      });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return answer;
    },
    call: (args: Readonly<Record<string, unknown>>) =>
      request("tools/call", { name: "octant_browser", arguments: args }),
    close: () => input.end(),
  };
}

describe("octant mcp against a terminal Browser grant", () => {
  it("lists the thread's Browser tool and runs a call the person approves", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const cli = typedCli(envOf(fixture, opening));

    expect(await cli.initialize()).toMatchObject({ result: { serverInfo: { name: "octant" } } });
    const listed = await cli.request("tools/list");
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "octant_browser",
    ]);
    const navigating = cli.call({ operation: "navigate", url: "https://example.com/docs" });
    expect(await approveNext(fixture)).toMatchObject({ origin: "https://example.com" });
    expect(await navigating).toMatchObject({ result: { isError: false } });
    cli.close();
    expect(await cli.finished).toBe(0);
    expect(cli.stderr()).toBe("");
  });

  it("refuses a call as unauthorized and ends once the person switches the grant off", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const cli = typedCli(envOf(fixture, opening));
    await cli.initialize();
    expect(await cli.call({ operation: "help" })).toMatchObject({ result: { isError: false } });

    await fixture.service.switchOff({ windowId, threadId: threadA, terminalId: terminalA });

    const refused = await cli.call({ operation: "help" });
    expect(refused["result"]).toMatchObject({
      isError: true,
      content: [{ text: '{"error":"unauthorized"}' }],
    });
    expect(await cli.finished).toBe(1);
    expect(cli.stderr().trim().split("\n")).toHaveLength(1);
  });

  it("ends when the endpoint itself answers a call unauthorized because the thread was archived", async (context) => {
    const fixture = harness();
    const opening = await open(fixture);
    if (opening.kind === "refused")
      return void context.skip("loopback listeners are not permitted");
    const cli = typedCli(envOf(fixture, opening));
    await cli.initialize();
    // A lifecycle notice that never arrived: only the call itself finds the thread gone.
    fixture.threads.set(ids.threadA, codeThread(ids.threadA, { lifecycle: "archived" }));

    const refused = await cli.call({ operation: "help" });

    expect(refused["result"]).toMatchObject({
      isError: true,
      content: [{ text: '{"error":"unauthorized"}' }],
    });
    expect(await cli.finished).toBe(1);
    expect(cli.stderr()).toContain("ended this terminal's Browser grant");
  });
});
