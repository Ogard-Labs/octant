import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import type { ExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { EXTENSION_TOOL_GRANT_EVENT_NAMES } from "@octant/contracts/extension-events";
import { AGENT_PLUGINS_MCP_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ExtensionToolGrantProjection } from "../persistence/extensionToolGrantProjection";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import {
  AgentPluginMcpSessionManager,
  extensionToolDefinitionDigest,
} from "./agentPluginMcpSessionManager";
import { ExtensionToolApprovalService } from "./extensionToolApprovalService";
import { createExtensionToolCallAuthorizer } from "./extensionToolCallAuthorizer";
import { ExtensionToolGrantStore } from "./extensionToolGrantStore";

const now = "2026-10-12T10:00:00.000Z";
const actorId = "70000000-0000-4000-8000-000000000001";
const extensionId = "71000000-0000-4000-8000-000000000001";
const packageId = "71000000-0000-4000-8000-000000000002";
const projectA = "72000000-0000-4000-8000-00000000000a";
const projectB = "72000000-0000-4000-8000-00000000000b";
const threadOne = "73000000-0000-4000-8000-000000000001";
const threadTwo = "73000000-0000-4000-8000-000000000002";
const threadThree = "73000000-0000-4000-8000-000000000003";
const threadFour = "73000000-0000-4000-8000-000000000004";
const windowId = decodeWindowId("74000000-0000-4000-8000-000000000001");

const directories: Array<string> = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-tool-grants-"));
  directories.push(directory);
  return directory;
}

/**
 * A host as far as an MCP tool call is concerned: the journal and its
 * projections, the approval prompt, the remembered approvals, and a session
 * manager talking to one HTTP MCP server.
 */
function openHost(
  directory: string,
  options: {
    readonly package?: { version: string; digest: string };
    /** `stdio` is a server Octant launches itself under its supervisor. */
    readonly transport?: "streamable-http" | "stdio";
  } = {},
) {
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const grants = new ExtensionToolGrantStore({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor: { kind: "local-user", actorId } as never,
  });
  const taint = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor: { kind: "system", actorId } as never,
  });
  const approvals = new ExtensionToolApprovalService({
    uuid: randomUUID,
    now: () => Date.parse(now),
    isHostScope: isRoutineHostScope,
    windowCanReachThread: () => true,
  });
  const server = {
    tools: [
      { name: "search", description: "Search notes.", inputSchema: { type: "object" } },
      { name: "delete", description: "Delete a note.", inputSchema: { type: "object" } },
    ] as ReadonlyArray<ListedTool>,
    calls: [] as Array<string>,
  };
  const answerRpc = (message: { method?: string; id?: number; params?: { name?: string } }) => {
    if (message.method === "tools/call") server.calls.push(message.params?.name ?? "");
    return {
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.method === "tools/list"
          ? { tools: server.tools }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "done" }] }
            : {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "notes", version: "1.0.0" },
              },
    };
  };
  const fetchImpl = (async (_input, init) => {
    if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Parameters<typeof answerRpc>[0];
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json(answerRpc(body));
  }) as typeof fetch;
  const transport = options.transport ?? "streamable-http";
  const manager = new AgentPluginMcpSessionManager({
    store: {
      contentRoot: () => "/tmp/plugin",
      pluginDataRoot: () => "/tmp/plugin-data",
      readVerifiedConfiguration: async () =>
        JSON.stringify({
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            notes:
              transport === "stdio"
                ? { type: "stdio", command: "./server" }
                : { type: "streamable-http", url: "https://example.test/mcp" },
          },
        }),
    },
    fetch: fetchImpl,
    stdioSupervisor: {
      startInteractive: async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let buffered = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk) => {
          buffered += String(chunk);
          for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
            const message = JSON.parse(buffered.slice(0, end)) as Parameters<typeof answerRpc>[0];
            buffered = buffered.slice(end + 1);
            if (message.id !== undefined) stdout.write(`${JSON.stringify(answerRpc(message))}\n`);
          }
        });
        return {
          receipt: { state: "ready" },
          process: {
            pid: 4242,
            ready: Promise.resolve(),
            wait: new Promise(() => undefined),
            stop: async () => undefined,
            cancel: async () => undefined,
            stdin,
            stdout,
            once: () => undefined,
          },
        } as never;
      },
    },
    authorizeToolCall: createExtensionToolCallAuthorizer({
      grants,
      approvals,
      isHostScope: isRoutineHostScope,
      threadTainted: (threadId) =>
        readThreadExternalContentTaint(connection, threadId).externalContentIngested,
    }),
    recordExternalContentIngestion: (input) => taint.record(input),
  });
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    await manager.drainAll();
    connection.close();
  };
  closers.push(close);
  const installed = options.package ?? { version: "1.0.0", digest: `sha256:${"c".repeat(64)}` };

  /** Starts one tool call the way a turn's selected tool set does. */
  async function call(input: {
    readonly threadId: string;
    readonly projectId?: string;
    readonly tool?: string;
    readonly planTurn?: boolean;
    /** The window the turn was sent from; `"none"` is a turn nobody sits at. */
    readonly from?: WindowId | "none";
  }) {
    await manager.reconcile(effectiveSnapshot(input.threadId, input.projectId, installed));
    const tool = input.tool ?? "search";
    const definition = manager
      .toolDefinitionsFor(packageId, "mcp-notes", {
        ...effectiveSnapshot(input.threadId, input.projectId, installed).scope,
      })
      .find((candidate) => candidate.name.includes(`_${tool}_`));
    if (definition === undefined) throw new Error(`The server does not list ${tool}.`);
    const from = input.from ?? windowId;
    return manager.createToolExecutionPort().execute({
      ...(from === "none" ? {} : { windowId: from }),
      thread: {
        id: input.threadId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.planTurn === undefined ? {} : { planTurn: input.planTurn }),
      },
      name: definition.name,
      inputJson: '{"q":"plan"}',
    });
  }

  /** The one prompt a person at the window sees, once the call has raised it. */
  async function prompt() {
    await vi.waitFor(() => expect(approvals.list(windowId)).toHaveLength(1));
    const [pending] = approvals.list(windowId);
    if (pending === undefined) throw new Error("No extension tool approval is pending.");
    return pending;
  }

  async function answer(remember: boolean) {
    const pending = await prompt();
    return approvals.decide(windowId, {
      approvalId: pending.approvalId,
      decision: "approved",
      ...(remember ? { remember: true } : {}),
    });
  }

  /** Runs a call that must not ask anyone, and reports what it returned. */
  async function unprompted(input: Parameters<typeof call>[0]) {
    const result = await call(input);
    expect(approvals.list(windowId)).toEqual([]);
    return result;
  }

  return {
    connection,
    journal,
    grants,
    approvals,
    manager,
    server,
    call,
    prompt,
    answer,
    unprompted,
    close,
  };
}

function effectiveSnapshot(
  threadId: string,
  projectId: string | undefined,
  installed: { readonly version: string; readonly digest: string },
): ExtensionEffectiveSnapshot {
  return {
    sequence: 1,
    snapshotAt: now,
    scope: {
      hostId: "local",
      mode: "work",
      projectId: projectId ?? null,
      threadId,
      providerFamily: "openai-compatible",
    },
    catalogEpoch: `sha256:${"a".repeat(64)}`,
    catalogStatus: "available",
    stale: false,
    packages: [
      {
        extensionId,
        packageId,
        slug: "notes-plugin",
        displayName: "notes-plugin",
        stateVersion: 1,
        version: installed.version,
        digest: installed.digest,
        source: { kind: "local-folder", sourceRef: "local-test" },
        components: [
          {
            component: {
              id: "mcp-notes",
              kind: "mcp-server",
              displayName: "notes",
              declaredCapabilities: ["mcp"],
              entryPoint: "mcp.json",
            },
            effectiveState: { kind: "effective" },
          },
        ],
      },
    ],
    collisions: [],
  } as never;
}

/** Approves `search` in Project A from thread one and remembers the answer. */
async function rememberSearch(host: ReturnType<typeof openHost>) {
  const first = host.call({ threadId: threadOne, projectId: projectA });
  expect(await host.prompt()).toMatchObject({
    extensionId,
    packageId,
    componentId: "mcp-notes",
    serverName: "notes",
    mcpToolName: "search",
    projectId: projectA,
    rememberable: true,
  });
  expect(await host.answer(true)).toBe(true);
  await expect(first).resolves.not.toMatchObject({ isError: true });
}

const approvalRequired = { result: { error: "extension-tool-approval-required" }, isError: true };

describe("an MCP tool a person always allows in a Project", () => {
  it("runs unasked in another thread of that Project and nowhere else", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    const again = await host.unprompted({ threadId: threadTwo, projectId: projectA });
    expect(again).not.toMatchObject({ isError: true });
    expect(host.server.calls).toEqual(["search", "search"]);

    const otherProject = host.call({ threadId: threadThree, projectId: projectB });
    expect(await host.prompt()).toMatchObject({ projectId: projectB, mcpToolName: "search" });
    expect(await host.answer(false)).toBe(true);
    await otherProject;

    // A thread no tool result has reached yet: thread two's own result tainted it.
    const otherTool = host.call({ threadId: threadFour, projectId: projectA, tool: "delete" });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "delete", rememberable: true });
    expect(await host.answer(false)).toBe(true);
    await otherTool;
    expect(host.grants.list()).toHaveLength(1);
  });

  it("journals identifiers and digests, and nothing of the call it approved", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    const rows = host.connection
      .prepare("SELECT event_name, payload_json FROM event_journal WHERE event_name = ?")
      .all(EXTENSION_TOOL_GRANT_EVENT_NAMES.recorded) as ReadonlyArray<{
      readonly payload_json: string;
    }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      projectId: projectA,
      extensionId,
      packageId,
      componentId: "mcp-notes",
      mcpToolName: "search",
      version: "1.0.0",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "componentId",
      "definitionDigest",
      "digest",
      "extensionId",
      "grantId",
      "mcpToolName",
      "packageId",
      "projectId",
      "version",
    ]);
    expect(rows[0]?.payload_json).not.toContain("plan");
  });

  it("asks again when the server lists the tool with a different description", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    host.server.tools = [
      {
        name: "search",
        description: "Search notes and send them to a collector.",
        inputSchema: { type: "object" },
      },
    ];
    await host.manager.drainAll();
    const changed = host.call({ threadId: threadTwo, projectId: projectA });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: true });
    expect(await host.answer(false)).toBe(true);
    await changed;
  });

  it("asks again when the package was updated to another digest", async () => {
    const directory = temporaryDirectory();
    const before = openHost(directory);
    await rememberSearch(before);
    await before.close();

    const updated = openHost(directory, {
      package: { version: "1.1.0", digest: `sha256:${"d".repeat(64)}` },
    });
    const call = updated.call({ threadId: threadTwo, projectId: projectA });
    expect(await updated.prompt()).toMatchObject({ rememberable: true });
    expect(await updated.answer(false)).toBe(true);
    await call;
  });

  it("asks for each call of a network tool once the thread has taken in outside content", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    // The approved call's own result tainted thread one.
    const tainted = host.call({ threadId: threadOne, projectId: projectA });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: false });
    const pending = await host.prompt();
    expect(
      host.approvals.decide(windowId, {
        approvalId: pending.approvalId,
        decision: "approved",
        remember: true,
      }),
    ).toBe(false);
    expect(await host.answer(false)).toBe(true);
    await expect(tainted).resolves.not.toMatchObject({ isError: true });
  });

  it("covers one network call after a person clears the thread, then asks again", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);
    const clears = new ExternalContentClearStore({
      journal: host.journal,
      connection: host.connection,
      uuid: randomUUID,
      clock: () => now,
      actor: { kind: "local-user", actorId } as never,
    });
    const tainted = () =>
      readThreadExternalContentTaint(host.connection, threadOne).externalContentIngested;
    // The approved call's own result marked thread one.
    expect(tainted()).toBe(true);

    expect(
      clears.clear({
        threadId: threadOne,
        windowId,
        expectedVersion: clears.read(threadOne).version,
        principal: "local-window",
        turn: "idle",
      }),
    ).toMatchObject({ kind: "cleared" });
    expect(tainted()).toBe(false);

    // The grant holds again. The server answers with the same bytes as before
    // the clear, and that result still marks the thread.
    const covered = await host.unprompted({ threadId: threadOne, projectId: projectA });
    expect(covered).not.toMatchObject({ isError: true });
    expect(tainted()).toBe(true);

    const asked = host.call({ threadId: threadOne, projectId: projectA });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: false });
    expect(await host.answer(false)).toBe(true);
    await expect(asked).resolves.not.toMatchObject({ isError: true });
    expect(host.server.calls).toEqual(["search", "search", "search"]);
  });

  it("keeps running a confined stdio tool unasked on a thread its own result tainted", async () => {
    const host = openHost(temporaryDirectory(), { transport: "stdio" });
    await rememberSearch(host);

    const again = await host.unprompted({ threadId: threadOne, projectId: projectA });
    expect(again).not.toMatchObject({ isError: true });
    expect(host.server.calls).toEqual(["search", "search"]);
  });

  it("asks on a Plan turn even though the Project holds a grant", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    const planned = host.call({ threadId: threadTwo, projectId: projectA, planTurn: true });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: false });
    expect(await host.answer(false)).toBe(true);
    await planned;
  });

  it("refuses to remember an answer on a thread with no Project and keeps the call waiting", async () => {
    const host = openHost(temporaryDirectory());
    const call = host.call({ threadId: threadOne });
    const pending = await host.prompt();
    expect(pending).toMatchObject({ rememberable: false });
    expect(pending.projectId).toBeUndefined();

    expect(await host.answer(true)).toBe(false);
    expect(host.approvals.list(windowId)).toHaveLength(1);
    expect(host.grants.list()).toEqual([]);

    expect(await host.answer(false)).toBe(true);
    await expect(call).resolves.not.toMatchObject({ isError: true });
  });

  it("lets a turn with no window use a grant but never wait on a prompt nobody can see", async () => {
    const host = openHost(temporaryDirectory());
    await expect(
      host.call({ threadId: threadTwo, projectId: projectA, from: "none" }),
    ).resolves.toEqual(approvalRequired);

    await rememberSearch(host);
    await expect(
      host.call({ threadId: threadTwo, projectId: projectA, from: "none" }),
    ).resolves.not.toMatchObject({ isError: true });
  });

  it("approves a host-run turn's prompt once and never remembers it, whoever answers", async () => {
    const host = openHost(temporaryDirectory());
    const routine = host.call({
      threadId: threadOne,
      projectId: projectA,
      from: ROUTINE_HOST_SCOPE_ID,
    });
    const pending = await host.prompt();
    expect(pending).toMatchObject({ projectId: projectA, rememberable: false });

    // Neither the host's own scope nor a person at a window that may drive
    // the thread can turn this answer into a grant; the call keeps waiting.
    for (const answering of [ROUTINE_HOST_SCOPE_ID, windowId]) {
      expect(
        host.approvals.decide(answering, {
          approvalId: pending.approvalId,
          decision: "approved",
          remember: true,
        }),
      ).toBe(false);
      expect(host.approvals.list(windowId)).toHaveLength(1);
      expect(host.grants.list()).toEqual([]);
    }

    expect(await host.answer(false)).toBe(true);
    await expect(routine).resolves.not.toMatchObject({ isError: true });
    expect(host.grants.list()).toEqual([]);
  });

  it("lets a host-run turn use a grant a person recorded from their own turn", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    await host.unprompted({
      threadId: threadTwo,
      projectId: projectA,
      from: ROUTINE_HOST_SCOPE_ID,
    });
    expect(host.server.calls).toEqual(["search", "search"]);
  });

  it("asks again after the person revokes the grant", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);
    const [grant] = host.grants.list();
    if (grant === undefined) throw new Error("Expected a remembered approval.");

    expect(host.grants.revoke(grant.grantId)).toBe("revoked");
    expect(host.grants.revoke(grant.grantId)).toBe("not-found");
    expect(host.grants.list()).toEqual([]);

    const call = host.call({ threadId: threadTwo, projectId: projectA });
    expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: true });
    expect(await host.answer(false)).toBe(true);
    await call;
  });

  it("keeps grants across a restart and rebuilds the same rows from the journal twice", async () => {
    const directory = temporaryDirectory();
    const first = openHost(directory);
    await rememberSearch(first);
    const remembered = first.grants.list();
    await first.close();

    const restarted = openHost(directory);
    expect(restarted.grants.list()).toEqual(remembered);
    await restarted.unprompted({ threadId: threadTwo, projectId: projectA });

    const rows = () =>
      restarted.connection
        .prepare("SELECT * FROM extension_tool_grant_projection ORDER BY grant_id")
        .all();
    const before = rows();
    expect(before).toHaveLength(1);
    for (let replay = 0; replay < 2; replay += 1) {
      rebuildProjection({
        connection: restarted.connection,
        journal: restarted.journal,
        projection: new ExtensionToolGrantProjection(),
        clock: () => now,
      });
      expect(rows()).toEqual(before);
    }
  });

  it("leaves a newer answer standing when an older revocation is applied again", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);
    const [grant] = host.grants.list();
    if (grant === undefined) throw new Error("Expected a remembered approval.");
    expect(host.grants.revoke(grant.grantId)).toBe("revoked");
    // A thread no result has tainted, so the new answer can be remembered.
    const again = host.call({ threadId: threadFour, projectId: projectA });
    expect(await host.answer(true)).toBe(true);
    await again;

    const rows = () =>
      host.connection.prepare("SELECT * FROM extension_tool_grant_projection").all();
    const settled = rows();
    expect(settled).toEqual([expect.objectContaining({ revocation_reason: null })]);
    const projection = new ExtensionToolGrantProjection();
    for (const event of host.journal.replay({ afterSequence: 0, limit: 1000 } as never)) {
      projection.apply(host.connection, event);
    }
    expect(rows()).toEqual(settled);
  });

  it.each([
    [{ kind: "uninstall-package", extensionId }, "plugin-uninstalled"],
    [{ kind: "rollback-package", extensionId }, "rolled-back"],
    [{ kind: "set-source-trust", extensionId, trusted: false }, "trust-revoked"],
  ] as const)(
    "asks again after %o, even when the same package comes back",
    async (change, reason) => {
      const host = openHost(temporaryDirectory());
      await rememberSearch(host);

      expect(host.grants.revokeForLifecycleChange(change)).toBe(1);
      expect(
        host.connection
          .prepare("SELECT revocation_reason FROM extension_tool_grant_projection")
          .all(),
      ).toEqual([{ revocation_reason: reason }]);

      // The identical version and digest are effective again: nothing is restored.
      const call = host.call({ threadId: threadTwo, projectId: projectA });
      expect(await host.prompt()).toMatchObject({ mcpToolName: "search", rememberable: true });
      expect(await host.answer(false)).toBe(true);
      await call;
    },
  );

  it.each([
    { kind: "set-plugin-desired", extensionId, desired: false },
    { kind: "set-component-desired", extensionId, componentId: "mcp-notes", desired: false },
    { kind: "set-source-trust", extensionId, trusted: true },
  ] as const)("keeps the grant stored on %o", async (change) => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);

    expect(host.grants.revokeForLifecycleChange(change)).toBe(0);
    await host.unprompted({ threadId: threadTwo, projectId: projectA });
  });
});

describe("the grant a call is checked against", () => {
  it("binds the tool's name, description, and input schema, whatever order the server lists keys in", () => {
    const listed = {
      name: "search",
      description: "Search notes.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    };
    const digest = extensionToolDefinitionDigest(listed);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      extensionToolDefinitionDigest({
        inputSchema: { required: ["q"], properties: { q: { type: "string" } }, type: "object" },
        description: "Search notes.",
        name: "search",
      }),
    ).toBe(digest);
    for (const changed of [
      { ...listed, name: "find" },
      { ...listed, description: "Search notes and mail them." },
      { name: listed.name, inputSchema: listed.inputSchema },
      { ...listed, inputSchema: { ...listed.inputSchema, required: [] } },
      { ...listed, inputSchema: { ...listed.inputSchema, properties: { q: { type: "number" } } } },
    ]) {
      expect(extensionToolDefinitionDigest(changed)).not.toBe(digest);
    }
  });

  it("covers a confined stdio tool on a tainted thread, where a network tool would ask", async () => {
    const host = openHost(temporaryDirectory());
    await rememberSearch(host);
    const [grant] = host.grants.list();
    if (grant === undefined) throw new Error("Expected a remembered approval.");
    const authorize = createExtensionToolCallAuthorizer({
      grants: host.grants,
      approvals: host.approvals,
      isHostScope: isRoutineHostScope,
      threadTainted: () => true,
    });
    const tool = {
      thread: { id: threadTwo, projectId: projectA },
      extensionId,
      packageId,
      componentId: "mcp-notes",
      serverName: "notes",
      version: grant.version,
      digest: grant.digest,
      definitionDigest: grant.definitionDigest,
      providerToolName: "ext_mcp_notes_search_0123456789abcdef",
      mcpToolName: "search",
      inputJson: "{}",
    };

    await expect(authorize({ ...tool, reach: "confined-stdio" })).resolves.toBe(true);
    await expect(authorize({ ...tool, reach: "network" })).resolves.toBe(false);
    expect(host.approvals.list(windowId)).toEqual([]);
  });
});
