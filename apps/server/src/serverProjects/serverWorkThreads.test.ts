import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderExecutionPolicy, ToolActionAuthority } from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { WorkThread } from "@octant/contracts/work-threads";
import { createNativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { ServerConnection } from "./serverConnection";
import {
  SERVER_RUNTIME_NOT_HARNESS,
  serverCodeCheckout,
  serverProjectOf,
} from "./serverProjectThreads";
import {
  bindServerWorkTurn,
  serverWorkBindingRevisionId,
  serverWorkProjectOf,
} from "./serverWorkThreads";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

function workProjectAt(folder: string): ServerProject {
  return {
    id: "11111111-1111-4111-8111-111111111112" as ServerProject["id"],
    name: "Notes",
    serverId: "5e7e0000-0000-4000-8000-000000000001" as ServerProject["serverId"],
    folder,
    boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
    mode: "work",
  };
}

function threadIn(project: ServerProject): WorkThread {
  return {
    id: "22222222-2222-4222-8222-222222222223",
    projectId: project.id,
    bindingRevisionId: serverWorkBindingRevisionId(project),
    providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
    modelId: "harness-model",
    lifecycle: "active",
    access: "ask-first",
  } as unknown as WorkThread;
}

const storeOf = (project: ServerProject) => ({
  project: (id: string) => (id === String(project.id) ? project : undefined),
  workProject: (id: string) =>
    id === String(project.id) && project.mode === "work" ? project : undefined,
  codeProject: (id: string) =>
    id === String(project.id) && project.mode !== "work" ? project : undefined,
});

describe("a server Work Project's threads", () => {
  it("hold the binding their Project derives, and nothing a Code thread could name", () => {
    const project = workProjectAt(tmpdir());
    const thread = threadIn(project);
    const store = storeOf(project);
    expect(serverWorkProjectOf(store, thread)).toBe(project);
    expect(
      serverWorkProjectOf(store, {
        ...thread,
        bindingRevisionId: "33333333-3333-4333-8333-333333333333" as never,
      }),
    ).toBeUndefined();
    // A Code thread derived from a Work Project's id is not a server Code thread.
    const derived = serverCodeCheckout(project);
    expect(
      serverProjectOf(store, {
        id: "22222222-2222-4222-8222-222222222224" as never,
        projectId: project.id,
        bindingRevisionId: derived.bindingRevisionId,
        repositoryId: derived.checkout.repositoryId,
        checkoutId: derived.checkout.id,
      }),
    ).toBeUndefined();
    // And a Code server Project holds no Work thread.
    const code = { ...project, mode: undefined };
    expect(serverWorkProjectOf(storeOf(code), threadIn(code))).toBeUndefined();
  });
});

describe.skipIf(!canRunThrowawaySshd)("a server Work Project's turn", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let folder = "";

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    folder = join(sshd.root, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "plan.md"), "# Plan\n");
  }, 30_000);

  afterAll(() => sshd?.stop());

  function turn(options: {
    readonly level: () => ProviderExecutionPolicy;
    readonly harness?: boolean;
    readonly alias?: () => string;
    readonly registered?: () => boolean;
  }) {
    const project = workProjectAt(folder);
    const thread = threadIn(project);
    const authority = {
      hostId: "00000000-0000-4000-8000-0000000000aa",
      mode: "work",
      projectId: project.id,
      rootId: thread.bindingRevisionId,
      providerInstanceId: thread.providerInstanceId,
      extension: { kind: "core" },
    } as unknown as ToolActionAuthority;
    const asked: Array<{ toolName: string; singleUse: boolean | undefined }> = [];
    // The person already allowed commands for the session on this thread.
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
      hostId: authority.hostId,
      readThreadTaint: () => false,
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-11-01T12:00:00.000Z",
    });
    const recorded: Array<{ threadId: string; command: string; status: string }> = [];
    const bound = bindServerWorkTurn(
      {
        store: {
          workProject: storeOf(project).workProject,
          addressOf: () =>
            options.registered?.() === false
              ? { kind: "refused", reason: "server-not-registered" }
              : {
                  kind: "address",
                  server: { alias: options.alias?.() ?? sshd.alias, user: sshd.user },
                  folder,
                },
        },
        connection,
        composition,
        record: (input) => {
          recorded.push({ threadId: input.threadId, command: input.command, status: input.status });
          return "recorded";
        },
      },
      { thread },
    );
    const call = async (name: string, input: unknown) => {
      if (bound.status !== "bound") throw new Error(bound.message);
      return bound.tools.execute({
        name,
        inputJson: JSON.stringify(input),
        signal: new AbortController().signal,
      });
    };
    return { bound, call, asked, recorded, thread };
  }

  it("reads, edits, and runs commands in the folder on the server, asking for every command", async () => {
    const { bound, call, asked, recorded, thread } = turn({ level: () => "approval-gated" });
    expect(bound).toMatchObject({ status: "bound", folder });
    if (bound.status !== "bound") return;
    expect(bound.tools.definitions.map((tool) => tool.name)).not.toContain("delegate");

    expect(await call("read", { path: "plan.md" })).toMatchObject({
      result: { lines: ["# Plan", ""] },
    });
    await call("edit", { path: "plan.md", oldText: "# Plan", newText: "# Plan on a server" });
    expect(readFileSync(join(folder, "plan.md"), "utf8")).toBe("# Plan on a server\n");

    await call("bash", { command: "pwd -P > where.txt" });
    await call("bash", { command: "true" });
    expect(readFileSync(join(folder, "where.txt"), "utf8").trim()).toBe(folder);
    // A remembered approval for commands does not cover one on a server.
    expect(asked.filter((ask) => ask.toolName === "bash")).toEqual([
      { toolName: "bash", singleUse: true },
      { toolName: "bash", singleUse: true },
    ]);
    expect(recorded).toEqual([
      { threadId: String(thread.id), command: "pwd -P > where.txt", status: "ran" },
      { threadId: String(thread.id), command: "true", status: "ran" },
    ]);
  });

  it("asks nobody at Full access", async () => {
    const full = turn({ level: () => "full-access" });
    await full.call("bash", { command: "true" });
    expect(full.asked).toEqual([]);
  });

  it("runs nothing anywhere when the connection cannot be made", async () => {
    let alias = sshd.alias;
    const { call } = turn({ level: () => "full-access", alias: () => alias });
    alias = sshd.closedAlias;
    const marker = join(tmpdir(), "octant-work-never");
    expect(await call("bash", { command: `touch ${marker}` })).toMatchObject({
      result: { error: "shell-unavailable" },
    });
    expect(existsSync(marker)).toBe(false);
    expect(await call("read", { path: "plan.md" })).toMatchObject({ isError: true });
  });

  it("refuses before anything runs when the server left the registry or the runtime is not the Octant Harness", () => {
    expect(turn({ level: () => "full-access", registered: () => false }).bound.status).toBe(
      "refused",
    );
    expect(turn({ level: () => "full-access", harness: false }).bound).toEqual({
      status: "refused",
      message: SERVER_RUNTIME_NOT_HARNESS,
    });
  });
});
