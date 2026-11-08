import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MovedThreadReference } from "@octant/contracts";
import { HANDOVER_NOTE_MAX_BYTES, ThreadHandovers, composeHandoverNote } from "./threadHandovers";
import { createThreadMoveStateStore, heldThreadsOf } from "./threadMoveStateStore";

const THREAD: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const HANDOVER = "12345678-1234-4234-8234-123456789012";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function world(options: { readonly busy?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "octant-handover-"));
  folders.push(base);
  const origin = join(base, "origin.git");
  const laptop = join(base, "laptop");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "clone", "-q", origin, laptop);
  git(laptop, "config", "user.name", "Person");
  git(laptop, "config", "user.email", "person@example.invalid");
  writeFileSync(join(laptop, "app.ts"), "export const version = 1;\n");
  git(laptop, "add", ".");
  git(laptop, "commit", "-q", "-m", "first");
  git(laptop, "push", "-q", "origin", "main");
  const frozen = new Set<string>();
  const recorded: string[] = [];
  const state = createThreadMoveStateStore(join(base, "data"));
  const handovers = new ThreadHandovers({
    source: {
      read: async () => ({
        status: "found",
        title: "Fix the flaky test",
        busy: options.busy === true,
        delegated: false,
        repositoryRemotes: [origin],
      }),
      freeze: (thread) => frozen.add(thread.threadId),
      unfreeze: (thread) => frozen.delete(thread.threadId),
      isFrozen: (thread) => frozen.has(thread.threadId),
    },
    code: {
      checkoutRoot: async () => laptop,
      provider: () => ({ driverKind: "claude", modelId: "model-a" }),
      latest: async () => ({
        instruction: "Make the retry deterministic",
        answer: `The retry now waits on the clock. See ${laptop}/app.ts.`,
      }),
    },
    record: { handoverStarted: (input) => recorded.push(input.branch) },
    state,
    originName: () => "Laptop",
    clock: () => "2026-11-08T12:00:00.000Z",
    uuid: () => HANDOVER,
  });
  return { base, origin, laptop, frozen, recorded, state, handovers };
}

describe("handing over a Code thread that cannot move", () => {
  it("previews the branch and note, then freezes, commits, and pushes, keeping the thread held", async () => {
    const { origin, laptop, frozen, recorded, state, handovers } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");

    const preview = await handovers.preview(THREAD);
    expect(preview).toMatchObject({
      status: "preview",
      branch: "octant/handover/fix-the-flaky-test-77777777",
      newBranch: true,
      remote: "origin",
    });
    expect(frozen.size).toBe(0);

    const outcome = await handovers.handOver(THREAD);
    expect(outcome).toEqual({
      status: "handed-over",
      handoverId: HANDOVER,
      branch: "octant/handover/fix-the-flaky-test-77777777",
      pushed: true,
      refusedFiles: [],
    });
    expect(recorded).toEqual(["octant/handover/fix-the-flaky-test-77777777"]);
    expect(frozen.has(THREAD.threadId)).toBe(true);
    expect(heldThreadsOf(state.load())).toEqual([THREAD]);
    const message = git(
      origin,
      "log",
      "-1",
      "--format=%B",
      "octant/handover/fix-the-flaky-test-77777777",
    );
    expect(message).toContain("Hand over: Fix the flaky test");
    expect(message).toContain("Make the retry deterministic");
    expect(message).toContain(`Octant-Handover: ${HANDOVER}`);
    expect(message).toContain("Octant-Origin: Laptop");
    expect(message).not.toContain(laptop);

    expect(handovers.takeBack(HANDOVER)).toEqual({ status: "taken-back" });
    expect(frozen.size).toBe(0);
    expect(heldThreadsOf(state.load())).toEqual([]);
  });

  it("refuses a thread with a running turn, and one with nothing to hand over, leaving it unfrozen", async () => {
    const busy = world({ busy: true });
    expect(await busy.handovers.handOver(THREAD)).toEqual({ status: "refused", reason: "busy" });
    expect(busy.frozen.size).toBe(0);

    const idle = world();
    expect(await idle.handovers.handOver(THREAD)).toEqual({
      status: "refused",
      reason: "nothing-to-hand-over",
    });
    expect(idle.frozen.size).toBe(0);
  });
});

describe("where a handover's work goes", () => {
  it("pushes to the remote the preview named, even when the new branch would fall back to another", async () => {
    const { origin, laptop, handovers } = world();
    // The checkout's branch tracks its own remote; origin is another repository.
    const upstream = join(laptop, "..", "upstream.git");
    git(join(laptop, ".."), "init", "-q", "--bare", "-b", "main", upstream);
    git(laptop, "remote", "add", "upstream", upstream);
    git(laptop, "push", "-q", "upstream", "main");
    git(laptop, "config", "branch.main.remote", "upstream");
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");

    expect(await handovers.preview(THREAD)).toMatchObject({ remote: "upstream" });
    expect(await handovers.handOver(THREAD)).toMatchObject({ pushed: true });

    const branch = "octant/handover/fix-the-flaky-test-77777777";
    expect(git(upstream, "log", "-1", "--format=%B", branch)).toContain(
      `Octant-Handover: ${HANDOVER}`,
    );
    expect(() => git(origin, "rev-parse", "--verify", "-q", branch)).toThrow();
  });

  it("gives a clean branch that already holds the work a commit carrying this handover's note", async () => {
    const { origin, laptop, handovers } = world();
    git(laptop, "checkout", "-q", "-b", "feature/flaky");
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    git(laptop, "commit", "-q", "-am", "make it deterministic");
    git(laptop, "push", "-q", "-u", "origin", "feature/flaky");

    expect(await handovers.handOver(THREAD)).toMatchObject({
      status: "handed-over",
      branch: "feature/flaky",
      pushed: true,
    });
    expect(git(origin, "log", "-1", "--format=%B", "feature/flaky")).toContain(
      `Octant-Handover: ${HANDOVER}`,
    );
    expect(git(origin, "show", "feature/flaky:app.ts")).toBe("export const version = 2;");
  });
});

describe("a handover that is retried or interrupted", () => {
  it("lets only one of two concurrent handovers of a thread proceed, and keeps its hold", async () => {
    const { laptop, frozen, state, handovers } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");

    const outcomes = await Promise.all([handovers.handOver(THREAD), handovers.handOver(THREAD)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["handed-over", "refused"]);
    expect(outcomes.find((outcome) => outcome.status === "refused")).toEqual({
      status: "refused",
      reason: "busy",
    });
    expect(frozen.has(THREAD.threadId)).toBe(true);
    expect(heldThreadsOf(state.load())).toEqual([THREAD]);
    // A thread already held stays out of reach of another handover too.
    expect(await handovers.handOver(THREAD)).toEqual({ status: "refused", reason: "busy" });
    expect(frozen.has(THREAD.threadId)).toBe(true);
  });

  it("takes the next free branch name for a second handover after Take back here", async () => {
    const { laptop, handovers } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    expect(await handovers.handOver(THREAD)).toMatchObject({
      branch: "octant/handover/fix-the-flaky-test-77777777",
    });
    handovers.takeBack(HANDOVER);

    writeFileSync(join(laptop, "app.ts"), "export const version = 3;\n");
    expect(await handovers.handOver(THREAD)).toMatchObject({
      status: "handed-over",
      branch: "octant/handover/fix-the-flaky-test-77777777-2",
      pushed: true,
    });
    // The earlier handover's branch is left as it was.
    expect(git(laptop, "show", "octant/handover/fix-the-flaky-test-77777777:app.ts")).toBe(
      "export const version = 2;",
    );
  });

  it("has saved the hold before it pushes, so a stop mid-push restarts with the thread held", async () => {
    const { base, laptop, handovers } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    // The push copies what this host had saved at that moment.
    const snapshot = join(base, "saved-at-push.json");
    const hook = join(laptop, ".git", "hooks", "pre-push");
    writeFileSync(
      hook,
      `#!/bin/sh\ncp "${join(base, "data", "hub", "thread-moves.json")}" "${snapshot}"\n`,
    );
    chmodSync(hook, 0o755);

    expect(await handovers.handOver(THREAD)).toMatchObject({ pushed: true });

    const saved = JSON.parse(readFileSync(snapshot, "utf8")) as {
      readonly handovers?: ReadonlyArray<{ readonly thread: MovedThreadReference }>;
    };
    expect(saved.handovers?.map((entry) => entry.thread)).toEqual([THREAD]);
  });
});

describe("the handover note", () => {
  const checkout = {
    head: "a".repeat(40),
    defaultBranch: "main",
    changes: ["M app.ts"],
    ignoredFiles: 3,
  };

  it("redacts secrets, names no folder on this computer, and stays within its size", () => {
    const note = composeHandoverNote({
      title: "Fix it",
      originName: "Laptop",
      branch: "feature/fix",
      checkout,
      checkoutRoot: "/Users/person/code/octant",
      answer: `Set key sk-ant-api03-${"a".repeat(90)} in /Users/person/code/octant/.env`,
      instruction: "x".repeat(100_000),
      handoverId: HANDOVER,
    });
    expect(note).not.toContain("sk-ant-api03");
    expect(note).not.toContain("/Users/person/code/octant");
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(HANDOVER_NOTE_MAX_BYTES);
    expect(note.trimEnd().endsWith(`Octant-Handover: ${HANDOVER}\nOctant-Origin: Laptop`)).toBe(
      true,
    );
  });
});
