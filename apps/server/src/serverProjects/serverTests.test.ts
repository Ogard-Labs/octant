import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCodeCheckoutId, decodeCodeThreadId } from "@octant/contracts/code";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeContentStore } from "../code/codeContentStore";
import { ServerCodeFiles } from "./serverCodeFiles";
import { ServerConnection } from "./serverConnection";
import { createServerRepositoryTests } from "./serverTests";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const threadId = decodeCodeThreadId("1a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");
const checkoutId = decodeCodeCheckoutId("6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");

describe.skipIf(!canRunThrowawaySshd)("a server Project's Tests panel", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let root = "";

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    root = join(sshd.root, "service");
    mkdirSync(join(root, ".octant"), { recursive: true });
    writeFileSync(join(root, "pass.sh"), '#!/bin/sh\ntouch ran-here\necho "$1"\n', { mode: 0o755 });
    writeFileSync(
      join(root, ".octant", "tests.json"),
      JSON.stringify({
        version: 1,
        tests: [
          {
            id: "pass",
            name: "Passes",
            argv: ["./pass.sh", "all good"],
            cwd: ".",
            environmentRefs: [],
            timeoutMs: 20_000,
            artifactPaths: [],
          },
          {
            id: "fail",
            name: "Fails",
            argv: ["false"],
            cwd: ".",
            environmentRefs: [],
            timeoutMs: 20_000,
            artifactPaths: [],
          },
        ],
      }),
    );
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=Server",
      "-c",
      "user.email=s@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Start",
    );
  }, 30_000);

  afterAll(() => sshd?.stop());

  const recorded: Array<{ readonly command: string; readonly status: string }> = [];
  const tests = (alias = () => sshd.alias) => {
    const server = () => ({ alias: alias(), user: sshd.user });
    return createServerRepositoryTests({
      connection,
      server: () => ({ ...server(), serverId: "5a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d" }),
      root,
      files: new ServerCodeFiles({
        connection,
        server,
        root,
        content: new CodeContentStore(),
        clock: () => "2026-11-01T12:00:00.000Z",
      }),
      record: (input) => {
        recorded.push({ command: input.command, status: input.status });
        return "recorded";
      },
      now: () => "2026-11-01T12:00:00.000Z",
      newId: () => "9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
    });
  };

  it("discovers the folder's tests on the server and runs one there", async () => {
    const panel = tests();
    const head = await panel.head();
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    const definitions = await panel.discover({ checkoutId: String(checkoutId), rootPath: root });
    expect(definitions.map((definition) => definition.name)).toEqual(["Passes", "Fails"]);
    const [passes, fails] = definitions;
    if (passes === undefined || fails === undefined || head === undefined) return;
    const run = (definition: typeof passes) =>
      panel.run({
        runId: "8a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
        definition,
        threadId,
        checkoutId,
        checkoutRevision: head,
        executionPolicy: "full-access",
        checkoutRoot: root,
        environment: { OPENAI_API_KEY: "sk-host" },
      });
    const passed = await run(passes);
    expect(passed).toMatchObject({ verdict: "passed", exitCode: 0 });
    expect(passed.stdout.text).toContain("all good");
    expect(existsSync(join(root, "ran-here"))).toBe(true);
    expect(await run(fails)).toMatchObject({ verdict: "failed", exitCode: 1 });
    expect(recorded).toEqual([
      { command: "./pass.sh all good", status: "ran" },
      { command: "false", status: "ran" },
    ]);
  });

  it("runs nothing anywhere when the server cannot be reached", async () => {
    const panel = tests(() => sshd.closedAlias);
    expect(await panel.head()).toBeUndefined();
    expect(await panel.discover({ checkoutId: String(checkoutId), rootPath: root })).toEqual([]);
  });
});
