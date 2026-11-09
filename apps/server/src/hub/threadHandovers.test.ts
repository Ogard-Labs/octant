import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MovedThreadReference } from "@octant/contracts";
import {
  HANDOVER_NOTE_MAX_BYTES,
  ThreadHandovers,
  composeHandoverNote,
  type HandoverCodeHost,
} from "./threadHandovers";
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

function world(
  options: {
    readonly busy?: boolean;
    /** Runs while the handover plans, before anything is written. */
    readonly whilePlanning?: () => void;
    /** The agent's summary turn; absent when this host offers none. */
    readonly summarize?: HandoverCodeHost["summarize"];
    readonly summaryTimeoutMs?: number;
  } = {},
) {
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
  const journaled: Array<{ readonly branch: string; readonly agentSummary?: string }> = [];
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
      latest: async () => {
        options.whilePlanning?.();
        return {
          instruction: "Make the retry deterministic",
          answer: `The retry now waits on the clock. See ${laptop}/app.ts.`,
        };
      },
      ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
    },
    record: {
      handoverStarted: (input) => {
        recorded.push(input.branch);
        journaled.push(input);
      },
    },
    state,
    originName: () => "Laptop",
    clock: () => "2026-11-08T12:00:00.000Z",
    uuid: () => HANDOVER,
    ...(options.summaryTimeoutMs === undefined
      ? {}
      : { summaryTimeoutMs: options.summaryTimeoutMs }),
  });
  return { base, origin, laptop, frozen, recorded, journaled, state, handovers };
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

describe("the agent's own summary in a handover note", () => {
  const BRANCH = "octant/handover/fix-the-flaky-test-77777777";
  const SUMMARY =
    "### Where the work stands\n\nThe retry is deterministic.\n\n### What comes next\n\nRun the suite twice.";

  it("adds one turn's summary under its own heading when the person left it on", async () => {
    const asked: string[] = [];
    const frozenWhileAsked: boolean[] = [];
    const handing = world({
      summarize: async (threadId) => {
        asked.push(threadId);
        frozenWhileAsked.push(handing.frozen.has(THREAD.threadId));
        return { status: "summarized", text: SUMMARY };
      },
    });
    writeFileSync(join(handing.laptop, "app.ts"), "export const version = 2;\n");

    // The preview spends no turn: only Commit and push asks the agent.
    expect(await handing.handovers.preview(THREAD)).toMatchObject({ status: "preview" });
    expect(asked).toEqual([]);

    expect(await handing.handovers.handOver(THREAD, undefined, { summarize: true })).toMatchObject({
      status: "handed-over",
      pushed: true,
    });
    expect(asked).toEqual([THREAD.threadId]);
    // The thread is frozen while its agent writes, so the summary describes work that is not moving.
    expect(frozenWhileAsked).toEqual([true]);
    expect(handing.journaled).toEqual([
      { handoverId: HANDOVER, thread: THREAD, branch: BRANCH, agentSummary: "added" },
    ]);
    const message = git(handing.origin, "log", "-1", "--format=%B", BRANCH);
    expect(message).toContain(`## The agent's summary\n\n${SUMMARY}`);
  });

  it("spends no turn when the person turned it off", async () => {
    const summarize = vi.fn<NonNullable<HandoverCodeHost["summarize"]>>();
    const handing = world({ summarize });
    writeFileSync(join(handing.laptop, "app.ts"), "export const version = 2;\n");

    expect(await handing.handovers.handOver(THREAD, undefined, { summarize: false })).toMatchObject(
      { status: "handed-over" },
    );
    expect(summarize).not.toHaveBeenCalled();
    expect(handing.journaled).toEqual([{ handoverId: HANDOVER, thread: THREAD, branch: BRANCH }]);
    expect(git(handing.origin, "log", "-1", "--format=%B", BRANCH)).not.toContain(
      "The agent's summary",
    );
  });

  it("hands over without the summary when the turn fails or the provider is not ready", async () => {
    const answers: ReadonlyArray<
      readonly [NonNullable<HandoverCodeHost["summarize"]>, "failed" | "unavailable"]
    > = [
      [async () => Promise.reject(new Error("provider exited")), "failed"],
      [async () => ({ status: "failed" }), "failed"],
      [async () => ({ status: "summarized", text: "   " }), "failed"],
      [async () => ({ status: "unavailable" }), "unavailable"],
    ];
    for (const [summarize, agentSummary] of answers) {
      const handing = world({ summarize });
      writeFileSync(join(handing.laptop, "app.ts"), "export const version = 2;\n");

      expect(
        await handing.handovers.handOver(THREAD, undefined, { summarize: true }),
      ).toMatchObject({ status: "handed-over", pushed: true });
      expect(handing.journaled.map((entry) => entry.agentSummary)).toEqual([agentSummary]);
      const message = git(handing.origin, "log", "-1", "--format=%B", BRANCH);
      expect(message).not.toContain("The agent's summary");
      expect(message).toContain(`Octant-Handover: ${HANDOVER}`);
    }
  });

  it("cancels a turn that runs past its bound and hands over without it", async () => {
    let cancelled = false;
    const handing = world({
      summaryTimeoutMs: 50,
      // A provider that never answers, even once cancelled.
      summarize: (_threadId, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => {
            cancelled = true;
          });
        }),
    });
    writeFileSync(join(handing.laptop, "app.ts"), "export const version = 2;\n");

    expect(await handing.handovers.handOver(THREAD, undefined, { summarize: true })).toMatchObject({
      status: "handed-over",
      pushed: true,
    });
    expect(cancelled).toBe(true);
    expect(handing.journaled.map((entry) => entry.agentSummary)).toEqual(["timed-out"]);
    expect(git(handing.origin, "log", "-1", "--format=%B", BRANCH)).not.toContain(
      "The agent's summary",
    );
  });

  it("asks nothing of a thread it refuses as busy", async () => {
    const summarize = vi.fn<NonNullable<HandoverCodeHost["summarize"]>>();
    const busy = world({ busy: true, summarize });
    expect(await busy.handovers.handOver(THREAD, undefined, { summarize: true })).toEqual({
      status: "refused",
      reason: "busy",
    });
    expect(summarize).not.toHaveBeenCalled();
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

  it("freezes the thread before it plans, so no turn can start while the note is written", async () => {
    const seen: boolean[] = [];
    const planning = world({
      whilePlanning: () => seen.push(planning.frozen.has(THREAD.threadId)),
    });
    writeFileSync(join(planning.laptop, "app.ts"), "export const version = 2;\n");

    expect(await planning.handovers.handOver(THREAD)).toMatchObject({ status: "handed-over" });
    expect(seen).toEqual([true]);
  });

  it("refuses Take back here while the handover is still pushing, and keeps the thread held", async () => {
    const { base, laptop, frozen, state, handovers } = world();
    writeFileSync(join(laptop, "app.ts"), "export const version = 2;\n");
    const pushing = join(base, "pushing");
    const hook = join(laptop, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch "${pushing}"\nsleep 1\n`);
    chmodSync(hook, 0o755);

    const handingOver = handovers.handOver(THREAD);
    await vi.waitFor(() => expect(existsSync(pushing)).toBe(true), { timeout: 5_000 });
    expect(handovers.takeBack(HANDOVER)).toEqual({ status: "refused", reason: "busy" });

    expect(await handingOver).toMatchObject({ status: "handed-over", pushed: true });
    expect(frozen.has(THREAD.threadId)).toBe(true);
    expect(heldThreadsOf(state.load())).toEqual([THREAD]);
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

  it("redacts the agent's summary and strips every folder on this computer from it", () => {
    const note = composeHandoverNote({
      title: "Fix it",
      originName: "Laptop",
      branch: "feature/fix",
      checkout,
      checkoutRoot: "/Users/person/code/octant",
      agentSummary: [
        `The token is sk-ant-api03-${"b".repeat(90)}.`,
        "Edited /Users/person/code/octant/app.ts and the scratch file /Users/person/Desktop/notes.txt.",
        "The log is at /tmp/octant-run/out.log; also see C:\\Users\\person\\notes.md.",
        "y".repeat(100_000),
      ].join("\n"),
      handoverId: HANDOVER,
    });
    expect(note).toContain("## The agent's summary");
    expect(note).toContain("Edited ./app.ts");
    expect(note).not.toContain("sk-ant-api03");
    expect(note).not.toContain("/Users/person");
    expect(note).not.toContain("/tmp/octant-run");
    expect(note).not.toContain("C:\\Users");
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(HANDOVER_NOTE_MAX_BYTES);
    expect(note).toContain(`Octant-Handover: ${HANDOVER}`);
  });
});
