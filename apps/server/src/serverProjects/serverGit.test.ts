import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerConnection } from "./serverConnection";
import { createServerGitService } from "./serverGit";
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
});
