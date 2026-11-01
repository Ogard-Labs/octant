import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerConnection } from "./serverConnection";
import { decodeGitHistoryQuery } from "@octant/contracts/git-history";
import { createServerGitHistory, createServerGitService } from "./serverGit";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("a server Project's Git panel", () => {
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
    mkdirSync(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Server Person");
    git("config", "user.email", "person@example.com");
    writeFileSync(join(root, "README.md"), "# Service\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "Start");
  }, 30_000);

  afterAll(() => sshd?.stop());

  const service = (alias = () => sshd.alias) =>
    createServerGitService({
      connection,
      server: () => ({ alias: alias(), user: sshd.user }),
    });

  it("reads, stages, and commits a change on the server", async () => {
    writeFileSync(join(root, "README.md"), "# Service\nnow on a server\n");
    const git = service();
    const observed = await git.observe(root);
    expect(observed).toMatchObject({
      status: "ready",
      head: { kind: "branch", name: "main" },
      changedPaths: ["README.md"],
      insertions: 1,
    });
    if (observed.status !== "ready") return;
    expect(observed.diff.text).toContain("+now on a server");

    const staged = await git.stage({
      checkoutId: "server-checkout",
      checkoutRoot: root,
      paths: ["README.md"],
      expectedStateToken: observed.stateToken,
      executionPolicy: "approval-gated",
    });
    expect(staged).toMatchObject({ status: "applied" });
    const ready = await git.observe(root);
    if (ready.status !== "ready") throw new Error("Git was not observed after staging.");
    const committed = await git.commit({
      checkoutId: "server-checkout",
      checkoutRoot: root,
      message: "Describe the server",
      expectedStateToken: ready.stateToken,
      stagedSummary: ready.stagedSummary,
      executionPolicy: "approval-gated",
    });
    expect(committed).toMatchObject({ status: "applied" });
    expect(execFileSync("git", ["-C", root, "log", "-1", "--format=%s %an"]).toString()).toBe(
      "Describe the server Server Person\n",
    );
    expect(await git.observe(root)).toMatchObject({ status: "ready", changedPaths: [] });
  }, 60_000);

  it("changes nothing at Plan, which Octant cannot hold Git to on a server", async () => {
    writeFileSync(join(root, "plan.txt"), "draft\n");
    const git = service();
    const observed = await git.observe(root);
    if (observed.status !== "ready") throw new Error("Git was not observed.");
    const staged = await git.stage({
      checkoutId: "server-checkout",
      checkoutRoot: root,
      paths: ["plan.txt"],
      expectedStateToken: observed.stateToken,
      executionPolicy: "plan",
    });
    expect(staged.status).not.toBe("applied");
    expect(execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"]).toString()).toBe(
      "",
    );
    expect(readFileSync(join(root, "plan.txt"), "utf8")).toBe("draft\n");
  }, 60_000);

  it("reports Git unavailable when the server cannot be reached, and runs nothing", async () => {
    const git = service(() => sshd.closedAlias);
    expect((await git.observe(root)).status).toBe("unavailable");
    const staged = await git.stage({
      checkoutId: "server-checkout",
      checkoutRoot: root,
      paths: ["plan.txt"],
      expectedStateToken: "0".repeat(64),
      executionPolicy: "full-access",
    });
    expect(staged.status).not.toBe("applied");
    expect(execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"]).toString()).toBe(
      "",
    );
  }, 60_000);

  const scope = {
    threadId: "c0000000-0000-4000-8000-000000000001",
    checkoutId: "c0000000-0000-4000-8000-000000000002",
  };

  it("reads the Review tool's history and one commit with Git on the server", async () => {
    const history = createServerGitHistory({
      connection,
      server: () => ({ alias: sshd.alias, user: sshd.user }),
    });
    const listed = await history.read(root, decodeGitHistoryQuery({ kind: "history", ...scope }));
    expect(listed).toMatchObject({ status: "history", branch: "main" });
    if (listed.status !== "history") return;
    const first = listed.commits.at(-1);
    expect(first?.subject).toBe("Start");
    if (first === undefined) return;
    const commit = await history.read(
      root,
      decodeGitHistoryQuery({ kind: "commit", ...scope, oid: first.oid, parent: 0 }),
    );
    expect(commit).toMatchObject({ status: "commit", files: 1 });
    if (commit.status === "commit") expect(commit.diff).toContain("+# Service");
  }, 60_000);

  it("reads no history when the server cannot be reached", async () => {
    const history = createServerGitHistory({
      connection,
      server: () => ({ alias: sshd.closedAlias, user: sshd.user }),
    });
    expect(
      (await history.read(root, decodeGitHistoryQuery({ kind: "history", ...scope }))).status,
    ).toBe("unavailable");
  }, 60_000);
});
