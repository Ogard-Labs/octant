import { describe, expect, it } from "vitest";
import {
  resolveAccountCliCommand,
  runAccountCliCommand,
  type AccountCliCommand,
} from "./accountCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";

const CLAUDE_ID = "80000000-0000-4000-8000-000000000001";
const SECOND_ID = "80000000-0000-4000-8000-000000000002";
const CODEX_ID = "80000000-0000-4000-8000-000000000003";
const STAMP = "2026-01-01T00:00:00.000Z";

function instance(id: string, driverKind: "claude" | "codex", displayName: string, extra = {}) {
  return {
    id,
    displayName,
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 3,
    createdAt: STAMP,
    updatedAt: STAMP,
    driverKind,
    configuration:
      driverKind === "claude"
        ? {
            kind: "claude-agent-sdk",
            binaryPath: "/bin/claude",
            authentication: "subscription",
            ...extra,
          }
        : { kind: "codex-cli", binaryPath: "/bin/codex", ...extra },
  };
}

function snapshot(instances: readonly unknown[]): LocalControlResponse {
  return {
    status: 200,
    body: {
      instances,
      defaults: { permissionPersistence: "current-session", version: 1 },
      observedStates: [],
    },
  };
}

const HOME_CLAUDE = instance(CLAUDE_ID, "claude", "Claude");
const OTHER_CLAUDE = instance(SECOND_ID, "claude", "Claude (2)", {
  configDirectory: "/home/me/.claude-accounts/two",
});

function fixture(instances: readonly unknown[], answer = "y") {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const ran: { binary: string; args: readonly string[]; env: Record<string, string> }[] = [];
  let current = [...instances];
  return {
    sent,
    out,
    err,
    asked,
    ran,
    run: (command: AccountCliCommand, options: { terminal?: boolean } = {}) =>
      runAccountCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "33333333-3333-4333-8333-333333333333",
          send: async (request) => {
            sent.push(request);
            if (request.method === "GET") return snapshot(current);
            const body = request.body as Record<string, unknown>;
            if (body.kind === "create-claude-provider" || body.kind === "create-codex-provider") {
              const claude = body.kind === "create-claude-provider";
              const created = instance(
                String(body.instanceId),
                claude ? "claude" : "codex",
                String(body.displayName),
                claude
                  ? { configDirectory: `/home/me/.claude-accounts/${String(body.instanceId)}` }
                  : { codexHome: `/home/me/.codex-accounts/${String(body.instanceId)}` },
              );
              current = [...current, created];
              return { status: 200, body: { kind: "provider-created", instance: created } };
            }
            return {
              status: 200,
              body: { kind: "provider-removed", instanceId: body.instanceId, version: 4 },
            };
          },
          close: async () => undefined,
        },
        ask:
          options.terminal === false
            ? undefined
            : async (question) => {
                asked.push(question);
                return answer;
              },
        run: async (binary, args, env) => {
          ran.push({ binary, args, env: { ...env } });
          return 0;
        },
        env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "host-token", OPENAI_API_KEY: "k" },
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      }),
  };
}

describe("octant account", () => {
  it("accepts the documented forms and rejects the rest", () => {
    expect(resolveAccountCliCommand(["list"], {})).toEqual({ action: "list" });
    expect(
      resolveAccountCliCommand(["add", "codex"], { "no-sign-in": true, name: "Work" }),
    ).toEqual({ action: "add", agent: "codex", name: "Work", signIn: false });
    expect(resolveAccountCliCommand(["remove", "Work"], { yes: true })).toEqual({
      action: "remove",
      account: "Work",
      yes: true,
    });
    expect(resolveAccountCliCommand(["add", "gemini"], {})).toBeUndefined();
    expect(resolveAccountCliCommand(["add", "claude"], { name: true })).toBeUndefined();
    expect(resolveAccountCliCommand(["sign-in"], {})).toBeUndefined();
    expect(resolveAccountCliCommand(["status", "a", "b"], {})).toBeUndefined();
    expect(resolveAccountCliCommand(["list"], { yes: true })).toBeUndefined();
  });

  it("lists accounts with their agent and directory, naming the default", async () => {
    const { out, run } = fixture([HOME_CLAUDE, OTHER_CLAUDE, instance(CODEX_ID, "codex", "Codex")]);

    expect(await run({ action: "list" })).toBe(0);

    expect(out.join("")).toBe(
      [
        "Claude  Claude  ~/.claude",
        "Claude (2)  Claude  /home/me/.claude-accounts/two",
        "Codex  Codex  ~/.codex",
        "",
      ].join("\n"),
    );
  });

  it("adds a Claude account without a directory, prints the assigned one and signs it in without host credentials", async () => {
    const { sent, out, ran, run } = fixture([HOME_CLAUDE]);

    expect(await run({ action: "add", agent: "claude", name: undefined, signIn: true })).toBe(0);

    const create = sent.find((request) => request.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(create).toMatchObject({
      kind: "create-claude-provider",
      expectedVersion: 0,
      displayName: "Claude (2)",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/bin/claude",
        authentication: "subscription",
      },
    });
    expect(create.configuration).not.toHaveProperty("configDirectory");
    expect(out.join("")).toContain(`/home/me/.claude-accounts/${String(create.instanceId)}`);
    const directory = `/home/me/.claude-accounts/${String(create.instanceId)}`;
    expect(ran).toEqual([
      {
        binary: "/bin/claude",
        args: ["auth", "login"],
        env: {
          PATH: "/usr/bin",
          OPENAI_API_KEY: "k",
          CLAUDE_CONFIG_DIR: directory,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: directory,
        },
      },
    ]);
  });

  it("refuses to add an account for an agent that has none to copy the binary from", async () => {
    const { sent, err, ran, run } = fixture([HOME_CLAUDE]);

    expect(await run({ action: "add", agent: "codex", name: undefined, signIn: true })).toBe(1);

    expect(err.join("")).toContain("Add Codex in Octant Settings first");
    expect(sent.filter((request) => request.method === "POST")).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("signs the default account in with no state directory variable", async () => {
    const { ran, run } = fixture([HOME_CLAUDE]);

    expect(await run({ action: "sign-in", account: "claude" })).toBe(0);

    expect(ran[0]?.env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "host-token",
      OPENAI_API_KEY: "k",
    });
  });

  it("refuses to remove without --yes when no terminal can answer", async () => {
    const { sent, err, run } = fixture([HOME_CLAUDE, OTHER_CLAUDE]);

    expect(
      await run({ action: "remove", account: "Claude (2)", yes: false }, { terminal: false }),
    ).toBe(1);

    expect(err.join("")).toContain("--yes");
    expect(sent.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("removes an account at its stored version after a yes and says its directory stayed", async () => {
    const { sent, out, asked, run } = fixture([HOME_CLAUDE, OTHER_CLAUDE]);

    expect(await run({ action: "remove", account: SECOND_ID, yes: false })).toBe(0);

    expect(asked[0]).toContain("/home/me/.claude-accounts/two stays on disk");
    expect(sent.at(-1)?.body).toEqual({
      kind: "remove-provider",
      instanceId: SECOND_ID,
      expectedVersion: 3,
    });
    expect(out.join("")).toContain("stayed on disk");
  });

  it("lists the candidates when a name is ambiguous", async () => {
    const { err, run } = fixture([
      HOME_CLAUDE,
      instance(CODEX_ID, "codex", "claude", { codexHome: "/x" }),
    ]);

    expect(await run({ action: "status", account: "CLAUDE" })).toBe(1);

    expect(err.join("")).toContain(`${CLAUDE_ID}  Claude (Claude)`);
    expect(err.join("")).toContain(`${CODEX_ID}  claude (Codex)`);
  });
});
