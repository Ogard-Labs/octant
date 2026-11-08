import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodeThread,
  MovedThreadReference,
  ThreadMoveId,
  ThreadMoveOffer,
} from "@octant/contracts";
import { createCodeThreadMoveHost, type CodeThreadMoveHostOptions } from "./codeThreadMoveHost";
import { createThreadMoveHolds } from "./threadMoveHolds";

const THREAD = "77777777-7777-4777-8777-777777777777";
const ARRIVING = "88888888-8888-4888-8888-888888888888";
const MOVE = "99999999-9999-4999-8999-999999999999" as ThreadMoveId;
const PROJECT = "55555555-5555-4555-8555-555555555555";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Person",
      GIT_AUTHOR_EMAIL: "person@example.invalid",
      GIT_COMMITTER_NAME: "Person",
      GIT_COMMITTER_EMAIL: "person@example.invalid",
    },
  }).trim();

function world() {
  const base = mkdtempSync(join(tmpdir(), "octant-code-move-"));
  folders.push(base);
  const origin = join(base, "origin.git");
  const laptop = join(base, "laptop");
  const desktop = join(base, "desktop");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, laptop);
  writeFileSync(join(laptop, ".gitignore"), ".env\n");
  writeFileSync(join(laptop, "app.ts"), "export const version = 1;\n");
  git(laptop, "add", ".");
  git(laptop, "commit", "-q", "-m", "first");
  git(laptop, "push", "-q", "origin", "main");
  git(laptop, "checkout", "-q", "-b", "feature/dark-mode");
  git(base, "clone", "-q", origin, desktop);
  const parts = join(base, "parts");
  execFileSync("mkdir", ["-p", parts]);
  return { laptop, desktop, parts };
}

function host(input: {
  readonly laptop: string;
  readonly desktop: string;
  readonly marked?: boolean;
}) {
  const created: Array<Parameters<CodeThreadMoveHostOptions["createThread"]>[0]> = [];
  const histories: Array<Parameters<CodeThreadMoveHostOptions["journalHistory"]>[0]> = [];
  const purged: string[] = [];
  const holds = createThreadMoveHolds();
  const thread = {
    id: THREAD,
    title: "Add dark mode",
    lifecycle: "active",
    providerInstanceId: "11111111-1111-4111-8111-111111111111",
    modelId: "model-a",
  } as unknown as CodeThread;
  const moveHost = createCodeThreadMoveHost({
    readThread: (id) => (String(id) === THREAD && !purged.includes(THREAD) ? thread : undefined),
    isBusy: () => false,
    checkoutRoot: async () => input.laptop,
    ownsManagedWorktree: () => false,
    providerDriverKind: () => "claude",
    transcript: async () => [
      {
        role: "person",
        text: "Add a dark mode toggle",
        occurredAt: "2026-11-08T10:00:00.000Z" as never,
      },
    ],
    externalContentIngested: () => input.marked === true,
    purge: async (id) => {
      purged.push(String(id));
    },
    codeProject: (projectId) =>
      projectId === PROJECT
        ? {
            projectId: PROJECT,
            canonicalRoot: input.desktop,
            repositoryId: "repo",
            bindingRevisionId: "binding",
          }
        : undefined,
    resolveProvider: (driverKind, modelId) =>
      driverKind === "claude"
        ? { providerInstanceId: "22222222-2222-4222-8222-222222222222", modelId }
        : undefined,
    createThread: async (created_) => {
      created.push(created_);
    },
    journalHistory: (history) => histories.push(history),
    holds,
  });
  return { moveHost, created, histories, purged, holds };
}

const offerFor = (
  parts: ReadonlyArray<{ partId: string; kind: string }>,
  remotes: ReadonlyArray<string>,
): ThreadMoveOffer =>
  ({
    moveId: MOVE,
    source: { mode: "code", threadId: THREAD },
    title: "Add dark mode",
    destinationProjectId: PROJECT,
    repositoryRemotes: remotes,
    manifest: { parts: parts.map((part) => ({ ...part, bytes: 1, sha256: "a".repeat(64) })) },
  }) as unknown as ThreadMoveOffer;

describe("moving a Code thread", () => {
  it("starts the destination thread from the moved commit and both snapshots, with its history", async () => {
    const { laptop, desktop, parts } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    git(laptop, "add", "app.ts");
    writeFileSync(join(laptop, "app.ts"), "export const version = 3;\n");
    const { moveHost, created, histories, holds } = host({ laptop, desktop });
    const source: MovedThreadReference = { mode: "code", threadId: THREAD };

    const packed = await moveHost.source.pack(source, parts, MOVE);
    if (packed.status !== "packed") throw new Error("Nothing was packed.");
    const remotes = [git(laptop, "remote", "get-url", "origin")];
    const offer = offerFor(packed.parts, remotes);
    expect(await moveHost.destination.acceptsProject(offer)).toBe(true);

    const planned: MovedThreadReference = { mode: "code", threadId: ARRIVING };
    const arrival = await moveHost.destination.arrive({
      thread: planned,
      offer,
      parts: new Map(packed.parts.map((part) => [part.partId, part.path])),
      origin: { memberId: "x" as never, thread: source },
      ownerMemberId: "y" as never,
    });

    expect(arrival).toEqual({ status: "arrived", thread: planned });
    expect(holds.isHeld(planned)).toBe(true);
    const [start] = created;
    if (start === undefined) throw new Error("No thread was started.");
    expect(start.branchIntent).toBe("feature/dark-mode");
    expect(start.provider.providerInstanceId).toBe("22222222-2222-4222-8222-222222222222");
    expect(git(desktop, "show", `${start.files.index}:app.ts`)).toBe("export const version = 2;");
    expect(git(desktop, "show", `${start.files.worktree}:app.ts`)).toBe(
      "export const version = 3;",
    );
    expect(start.head).toBe(git(laptop, "rev-parse", "HEAD"));
    expect(histories).toMatchObject([{ threadId: ARRIVING, moveId: MOVE }]);
  });

  it("starts the destination thread marked when the source thread had read outside content", async () => {
    const { laptop, desktop, parts } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const { moveHost, created } = host({ laptop, desktop, marked: true });
    const source: MovedThreadReference = { mode: "code", threadId: THREAD };
    const packed = await moveHost.source.pack(source, parts, MOVE);
    if (packed.status !== "packed") throw new Error("Nothing was packed.");
    const offer = offerFor(packed.parts, [git(laptop, "remote", "get-url", "origin")]);

    await moveHost.destination.arrive({
      thread: { mode: "code", threadId: ARRIVING },
      offer,
      parts: new Map(packed.parts.map((part) => [part.partId, part.path])),
      origin: { memberId: "x" as never, thread: source },
      ownerMemberId: "y" as never,
    });

    expect(created[0]?.inheritedMark).toEqual({
      sourceLabel: "moved-thread",
      contentReference: `moved-thread-${MOVE}`,
    });
  });

  it("refuses a destination Project bound to another repository", async () => {
    const { laptop, desktop, parts } = world();
    const { moveHost } = host({ laptop, desktop });
    const packed = await moveHost.source.pack({ mode: "code", threadId: THREAD }, parts, MOVE);
    if (packed.status !== "packed") throw new Error("Nothing was packed.");
    expect(
      await moveHost.destination.acceptsProject(
        offerFor(packed.parts, ["https://github.com/someone/else.git"]),
      ),
    ).toBe(false);
  });

  it("purges the source thread and reports its checkout kept when it holds what the move did not carry", async () => {
    const { laptop, desktop, parts } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const { moveHost, purged } = host({ laptop, desktop });
    const source: MovedThreadReference = { mode: "code", threadId: THREAD };
    await moveHost.source.pack(source, parts, MOVE);
    writeFileSync(join(laptop, ".env"), "LOCAL_ONLY=1\n");

    expect(await moveHost.source.erase({ thread: source, moveId: MOVE })).toEqual({
      worktreeKept: true,
    });
    expect(purged).toEqual([THREAD]);
  });
});
