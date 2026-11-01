import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeThread } from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { ManagedCodeThreadCreationInput } from "../code/codeService";
import { ServerConnection } from "./serverConnection";
import {
  serverCodeCheckout,
  serverThreadOf,
  serverWorktreeCheckout,
  serverWorktreeFolder,
} from "./serverProjectThreads";
import {
  listServerWorktreeRefs,
  serverPullRequestRepository,
  withServerWorktreeCreation,
} from "./serverWorktrees";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const projectId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";

function projectAt(folder: string): ServerProject {
  return {
    id: projectId as ServerProject["id"],
    name: "Site",
    serverId: "5e7e0000-0000-4000-8000-000000000001" as ServerProject["serverId"],
    folder,
    boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
  };
}

describe("a server thread's own worktree", () => {
  it("is found only under the checkout the Project and thread derive", () => {
    const project = projectAt("/srv/site");
    const store = { codeProject: (id: string) => (id === projectId ? project : undefined) };
    const derived = serverCodeCheckout(project);
    const worktree = serverWorktreeCheckout(project, threadId, project.boundAt);
    const thread = {
      id: threadId,
      projectId: project.id,
      bindingRevisionId: derived.bindingRevisionId,
      repositoryId: derived.checkout.repositoryId,
      checkoutId: worktree.checkout.id,
    } as unknown as CodeThread;
    expect(worktree.checkout.kind).toBe("remote-root");
    expect(serverThreadOf(store, thread)?.folder).toBe(
      `/srv/.octant-worktrees/${String(derived.checkout.repositoryId)}/${threadId}`,
    );
    // Another thread holding this checkout is not the worktree's thread.
    expect(
      serverThreadOf(store, { ...thread, id: "33333333-3333-4333-8333-333333333333" as never }),
    ).toBeUndefined();
  });
});

describe.skipIf(!canRunThrowawaySshd)("a worktree on a server", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let folder = "";
  let project: ServerProject;
  const local = {
    prepare: vi.fn(),
    commit: vi.fn(),
    cleanup: vi.fn(async () => ({ status: "removed" as const })),
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    folder = join(sshd.root, "site");
    mkdirSync(folder);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Server Person");
    git("config", "user.email", "person@example.com");
    writeFileSync(join(folder, "README.md"), "# Site\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "Start");
    project = projectAt(folder);
  }, 30_000);

  afterAll(() => sshd?.stop());

  const options = (alias = () => sshd.alias) => ({
    store: {
      codeProject: (id: string) => (id === projectId ? project : undefined),
      addressOf: () => ({
        kind: "address" as const,
        server: { alias: alias(), user: sshd.user },
        folder,
      }),
    },
    connection,
  });
  const input = (branchIntent: string): ManagedCodeThreadCreationInput =>
    ({
      authenticatedWindowId: "00000000-0000-4000-8000-000000000471",
      projectId,
      bindingRevisionId: serverCodeCheckout(project).bindingRevisionId,
      threadId,
      branchIntent,
      sourceBranch: "main",
      startFromOrigin: false,
    }) as unknown as ManagedCodeThreadCreationInput;
  const signal = new AbortController().signal;

  it("lists the server's branches, marking the one checked out", async () => {
    const refs = await listServerWorktreeRefs(options(), projectId, signal);
    expect(refs).toEqual([{ name: "main", kind: "local", isCurrent: true }]);
    expect(await listServerWorktreeRefs(options(), "another", signal)).toBeUndefined();
  });

  it("makes the thread's worktree on a new branch beside the folder, and removes it on rollback", async () => {
    const creation = withServerWorktreeCreation(options(), local);
    const prepared = await creation.prepare(input("octant/fix-1"), signal);
    expect(prepared).toMatchObject({
      status: "prepared",
      preparation: {
        checkoutKind: "remote-root",
        resolvedHead: git("rev-parse", "main"),
        checkoutId: serverWorktreeCheckout(project, threadId, project.boundAt).checkout.id,
      },
    });
    if (prepared.status !== "prepared") return;
    const committed = await creation.commit(input("octant/fix-1"), prepared.preparation, signal);
    expect(committed).toMatchObject({ status: "created", expectedHead: git("rev-parse", "main") });
    const worktree = serverWorktreeFolder(project, threadId);
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("# Site\n");
    expect(
      execFileSync("git", ["-C", worktree, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("octant/fix-1");
    // The person's own checkout is untouched.
    expect(git("branch", "--show-current")).toBe("main");
    expect(local.prepare).not.toHaveBeenCalled();

    if (committed.status !== "created") return;
    expect(await creation.cleanup({ receiptId: committed.receiptId }, signal)).toEqual({
      status: "removed",
    });
    expect(existsSync(worktree)).toBe(false);
    expect(git("branch", "--list", "octant/fix-1")).toBe("");
  }, 30_000);

  it("refuses a branch that already exists and changes nothing", async () => {
    git("branch", "taken");
    const creation = withServerWorktreeCreation(options(), local);
    const prepared = await creation.prepare(input("taken"), signal);
    if (prepared.status !== "prepared") throw new Error("expected a preparation");
    expect(await creation.commit(input("taken"), prepared.preparation, signal)).toEqual({
      status: "refused",
      reason: "branch-collision",
    });
    expect(existsSync(serverWorktreeFolder(project, threadId))).toBe(false);
  }, 30_000);

  it("runs nothing on the server for a Plan thread, not even the source fetch", async () => {
    const run = vi.fn();
    const creation = withServerWorktreeCreation(
      { ...options(), connection: { run } as unknown as ServerConnection },
      local,
    );
    expect(
      await creation.prepare(
        { ...input("octant/fix-3"), startFromOrigin: true, executionPolicy: "plan" },
        signal,
      ),
    ).toEqual({ status: "refused", reason: "plan-on-server" });
    expect(run).not.toHaveBeenCalled();
  });

  it("makes nothing anywhere when the server cannot be reached", async () => {
    const creation = withServerWorktreeCreation(
      options(() => sshd.closedAlias),
      local,
    );
    expect(await creation.prepare(input("octant/fix-2"), signal)).toEqual({
      status: "refused",
      reason: "server-unreachable",
    });
    expect(local.prepare).not.toHaveBeenCalled();
    expect(existsSync(serverWorktreeFolder(project, threadId))).toBe(false);
  }, 30_000);

  it("names the pull request's repository by the GitHub remote on the server", async () => {
    git("remote", "add", "origin", "git@github.com:acme/site.git");
    const derived = serverCodeCheckout(project);
    const thread = {
      id: threadId,
      projectId: project.id,
      bindingRevisionId: derived.bindingRevisionId,
      repositoryId: derived.checkout.repositoryId,
      checkoutId: derived.checkout.id,
      deliveryTarget: { remoteName: "origin", proposedBaseRepository: "local/Site" },
    } as unknown as CodeThread;
    expect(await serverPullRequestRepository(options(), thread)).toBe("acme/site");
    // A repository the person named is theirs to keep.
    expect(
      await serverPullRequestRepository(options(), {
        ...thread,
        deliveryTarget: { ...thread.deliveryTarget, proposedBaseRepository: "acme/fork" },
      }),
    ).toBe("acme/fork");
    expect(
      await serverPullRequestRepository(
        options(() => sshd.closedAlias),
        thread,
      ),
    ).toBe("local/Site");
  }, 30_000);
});
