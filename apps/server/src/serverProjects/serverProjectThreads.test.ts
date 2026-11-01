import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeThread, ProviderExecutionPolicy, ToolActionAuthority } from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import { decodeWindowId } from "@octant/contracts";
import { createNativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { ServerConnection } from "./serverConnection";
import {
  bindServerCodeTurn,
  SERVER_RUNTIME_NOT_HARNESS,
  serverCodeCheckout,
  serverCodeCheckoutRoot,
  serverProjectOf,
} from "./serverProjectThreads";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000471");

function projectAt(folder: string): ServerProject {
  return {
    id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
    name: "Site",
    serverId: "5e7e0000-0000-4000-8000-000000000001" as ServerProject["serverId"],
    folder,
    boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
  };
}

function threadIn(project: ServerProject): CodeThread {
  const derived = serverCodeCheckout(project);
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    bindingRevisionId: derived.bindingRevisionId,
    repositoryId: derived.checkout.repositoryId,
    checkoutId: derived.checkout.id,
    providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
    modelId: "harness-model",
    executionPolicy: "approval-gated",
  } as unknown as CodeThread;
}

describe("a server Project's checkout", () => {
  it("is derived from the Project alone and names no folder of this host", () => {
    const project = projectAt(tmpdir());
    const thread = threadIn(project);
    const store = { project: (id: string) => (id === String(project.id) ? project : undefined) };
    expect(serverCodeCheckout(project).checkout.kind).toBe("remote-root");
    expect(serverProjectOf(store, thread)).toBe(project);
    expect(serverCodeCheckoutRoot(store, thread)?.checkoutRoot).toBe(project.folder);
    // A thread whose checkout another Project or another build derived is not this Project's.
    expect(
      serverProjectOf(store, {
        ...thread,
        checkoutId: "33333333-3333-4333-8333-333333333333" as never,
      }),
    ).toBeUndefined();
    expect(
      serverProjectOf(store, {
        ...thread,
        projectId: "44444444-4444-4444-8444-444444444444" as never,
      }),
    ).toBeUndefined();
  });
});

describe.skipIf(!canRunThrowawaySshd)("a server Project's turn", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let folder = "";

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    folder = join(sshd.root, "site");
    mkdirSync(folder);
    writeFileSync(join(folder, "index.html"), "<h1>Hello</h1>\n");
  }, 30_000);

  afterAll(() => sshd?.stop());

  function turn(options: {
    readonly level: () => ProviderExecutionPolicy;
    readonly harness?: boolean;
    readonly alias?: () => string;
  }) {
    const project = projectAt(folder);
    const thread = threadIn(project);
    const authority = {
      hostId: "00000000-0000-4000-8000-0000000000aa",
      mode: "code",
      projectId: project.id,
      rootId: thread.bindingRevisionId,
      worktreeId: thread.checkoutId,
      providerInstanceId: thread.providerInstanceId,
      extension: { kind: "core" },
    } as unknown as ToolActionAuthority;
    // The person already allowed commands for the session on this thread.
    const asked: Array<{ toolName: string; singleUse: boolean | undefined }> = [];
    const approvals = {
      ask: vi.fn(async (input: { toolName: string; singleUse?: boolean }) => {
        asked.push({ toolName: input.toolName, singleUse: input.singleUse });
        return "approved" as const;
      }),
      remembers: (_threadId: string, approvalClass: string, singleUse: boolean) =>
        !singleUse && approvalClass === "shell-commands",
    };
    const composition = createNativeHarnessComposition({
      isChildAuthorityCurrent: () => true,
      authority: {
        resolve: () => authority,
        service: new ToolCallAuthorityService({
          resolveGrantedAuthority: () => authority,
          resolveLiveFacts: () => ({
            providerAppManagedTools: "supported",
            host: { computerUseEnabled: false },
            executionPolicy: options.level(),
            approvalSatisfied: options.level() === "full-access",
            externalContentIngested: false,
          }),
        }),
      },
      isHarnessProvider: () => options.harness ?? true,
      approvals: approvals as never,
      readCodeExecutionPolicy: () => options.level(),
      hostId: authority.hostId,
      readThreadTaint: () => false,
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-11-01T12:00:00.000Z",
    });
    const recorded: Array<{ command: string; status: string; exitCode?: number }> = [];
    const bound = bindServerCodeTurn(
      {
        store: {
          project: (id) => (id === String(project.id) ? project : undefined),
          addressOf: () => ({
            kind: "address",
            server: { alias: options.alias?.() ?? sshd.alias, user: sshd.user },
            folder,
          }),
        },
        connection,
        composition,
        record: (input) => {
          recorded.push({
            command: input.command,
            status: input.status,
            ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
          });
          return "recorded";
        },
      },
      { thread, windowId, secrets: [] },
    );
    const call = async (name: string, input: unknown) => {
      if (bound.status !== "bound") throw new Error(bound.message);
      return bound.tools.execute({
        name,
        inputJson: JSON.stringify(input),
        signal: new AbortController().signal,
      });
    };
    return { bound, call, asked, recorded };
  }

  it("reads, edits, and runs commands on the server, asking for every command", async () => {
    const { bound, call, asked, recorded } = turn({ level: () => "approval-gated" });
    expect(bound.status).toBe("bound");
    if (bound.status !== "bound") return;
    expect(bound.tools.definitions.map((tool) => tool.name)).not.toContain("delegate");

    expect(await call("read", { path: "index.html" })).toMatchObject({
      result: { lines: ["<h1>Hello</h1>", ""] },
    });
    await call("edit", { path: "index.html", oldText: "Hello", newText: "Hi" });
    expect(readFileSync(join(folder, "index.html"), "utf8")).toBe("<h1>Hi</h1>\n");

    const first = await call("bash", { command: "pwd -P && echo ran > ran.txt" });
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first.result)).toContain(folder);
    await call("bash", { command: "git --version >/dev/null 2>&1; exit 3" });
    // A remembered approval for commands does not cover one on a server.
    expect(asked.filter((ask) => ask.toolName === "bash")).toEqual([
      { toolName: "bash", singleUse: true },
      { toolName: "bash", singleUse: true },
    ]);
    expect(existsSync(join(folder, "ran.txt"))).toBe(true);
    expect(recorded).toEqual([
      { command: "pwd -P && echo ran > ran.txt", status: "ran", exitCode: 0 },
      { command: "git --version >/dev/null 2>&1; exit 3", status: "ran", exitCode: 3 },
    ]);
  });

  it("asks nobody at Full access, and offers no command in Plan", async () => {
    const full = turn({ level: () => "full-access" });
    await full.call("bash", { command: "true" });
    expect(full.asked).toEqual([]);

    const plan = turn({ level: () => "plan" });
    expect(
      plan.bound.status === "bound" && plan.bound.tools.definitions.map((tool) => tool.name),
    ).not.toContain("bash");
  });

  it("runs nothing anywhere when the connection cannot be made", async () => {
    let alias = sshd.alias;
    const { call, recorded } = turn({ level: () => "full-access", alias: () => alias });
    alias = sshd.closedAlias;
    const command = await call("bash", { command: `touch ${join(tmpdir(), "octant-never")}` });
    expect(command.result).toEqual({ error: "shell-unavailable" });
    expect(existsSync(join(tmpdir(), "octant-never"))).toBe(false);
    expect(recorded.at(-1)?.status).toBe("unavailable");
    expect(await call("read", { path: "index.html" })).toMatchObject({ isError: true });
  });

  it("refuses a runtime other than the Octant Harness before anything runs", () => {
    expect(turn({ level: () => "full-access", harness: false }).bound).toEqual({
      status: "refused",
      message: SERVER_RUNTIME_NOT_HARNESS,
    });
  });
});
