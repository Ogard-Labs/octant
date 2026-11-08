import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HandoverNotice, MovedThreadReference } from "@octant/contracts";
import {
  HANDOVER_ROUTES,
  HandoverExchange,
  type HandoverExchangeOptions,
} from "./handoverExchange";
import { createThreadMoveStateStore } from "./threadMoveStateStore";

const LAPTOP = "33333333-3333-4333-8333-333333333333";
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const HANDOVER = "12345678-1234-4234-8234-123456789012";
const NEW_THREAD = "88888888-8888-4888-8888-888888888888";
const THREAD: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const REMOTE = "git@github.com:person/octant.git";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const notice: HandoverNotice = {
  handoverId: HANDOVER as never,
  title: "Fix the flaky test",
  repositoryRemote: REMOTE,
  branch: "feature/flaky",
  providerDriverKind: "claude",
  modelId: "model-a",
};

function store() {
  const folder = mkdtempSync(join(tmpdir(), "octant-handover-exchange-"));
  folders.push(folder);
  return createThreadMoveStateStore(folder);
}

function world(overrides: Partial<HandoverExchangeOptions> = {}) {
  const laptopState = store();
  laptopState.save({
    ...laptopState.load(),
    handovers: [
      {
        handoverId: HANDOVER as never,
        thread: THREAD,
        branch: "feature/flaky",
        pushed: true,
        refusedFiles: [],
        handedOverAt: "2026-11-08T12:00:00.000Z" as never,
      },
    ],
  });
  const erased: string[] = [];
  const created: string[] = [];
  const notes: string[] = [];
  let laptop: HandoverExchange | undefined;
  const signed = (body: unknown) => ({
    header: "signed",
    publicKey: null,
    method: "POST",
    path: "",
    body: JSON.stringify(body),
  });
  const base = (memberId: string): Omit<HandoverExchangeOptions, "state"> => ({
    authenticate: () => ({ status: "member", memberId, moveIn: true }),
    send: async () => ({ status: "unreachable" }),
    memberName: (id) => (id === LAPTOP ? "Laptop" : "Desktop"),
    codeProjects: () => [{ projectId: PROJECT as never, title: "octant" }],
    acceptsProject: (placement) => placement.repositoryRemotes?.[0] === REMOTE,
    resolveProvider: (driverKind, modelId) =>
      driverKind === "claude" ? { providerInstanceId: "provider-b", modelId } : undefined,
    readNote: async ({ handoverId }) =>
      `Hand over: Fix the flaky test\n\nOctant-Handover: ${handoverId}`,
    branchTaken: async () => false,
    createThread: async (input) => {
      created.push(String(input.threadId));
    },
    journalNote: (input) => notes.push(input.note),
    source: {
      erase: async ({ thread }) => {
        erased.push(thread.threadId);
        return { worktreeKept: true, keptWorktree: "/w/octant-moved-out" };
      },
      unfreeze: () => {},
    },
    clock: () => "2026-11-08T13:00:00.000Z",
    uuid: () => NEW_THREAD,
  });
  laptop = new HandoverExchange({ ...base(DESKTOP), state: laptopState });
  const desktopState = store();
  const desktop = new HandoverExchange({
    ...base(LAPTOP),
    state: desktopState,
    send: async (target, path, body) => {
      if (target !== LAPTOP || path !== HANDOVER_ROUTES.continued || laptop === undefined) {
        return { status: "unreachable" };
      }
      const answer = await laptop.receiveContinued(signed(body));
      return { status: "answered", body: answer.body };
    },
    ...overrides,
  });
  return { desktop, desktopState, laptopState, erased, created, notes, signed };
}

describe("continuing a handover on another computer", () => {
  it("starts the thread on a suffixed branch when the destination already has one of that name", async () => {
    const opened: Array<{ readonly branch: string; readonly threadBranch: string }> = [];
    const { desktop, signed } = world({
      branchTaken: async ({ branch }) => branch === "feature/flaky",
      createThread: async (input) => {
        opened.push({ branch: input.branch, threadBranch: input.threadBranch });
      },
    });
    await desktop.receiveNotice(signed(notice));

    expect(
      await desktop.continueHandover({
        handoverId: HANDOVER as never,
        projectId: PROJECT as never,
      }),
    ).toEqual({ status: "continued", thread: { mode: "code", threadId: NEW_THREAD } });
    // It still starts from the fetched handover branch.
    expect(opened).toEqual([
      { branch: "feature/flaky", threadBranch: "feature/flaky-handover-88888888" },
    ]);
  });

  it("lists a noticed handover with its Projects, continues it, and the source erases its copy", async () => {
    const { desktop, desktopState, laptopState, erased, created, notes, signed } = world();
    expect((await desktop.receiveNotice(signed(notice))).httpStatus).toBe(200);

    const listed = await desktop.list();
    expect(listed.handovers).toEqual([
      expect.objectContaining({
        title: "Fix the flaky test",
        branch: "feature/flaky",
        originName: "Laptop",
        projects: [{ projectId: PROJECT, title: "octant" }],
      }),
    ]);

    expect(
      await desktop.continueHandover({
        handoverId: HANDOVER as never,
        projectId: PROJECT as never,
      }),
    ).toEqual({ status: "continued", thread: { mode: "code", threadId: NEW_THREAD } });
    expect(created).toEqual([NEW_THREAD]);
    expect(notes[0]).toContain(`Octant-Handover: ${HANDOVER}`);
    expect(desktopState.load().receivedHandovers).toEqual([]);

    await expect.poll(() => erased).toEqual([THREAD.threadId]);
    expect(laptopState.load().handovers).toEqual([]);
    expect(laptopState.load().departures?.[0]).toMatchObject({
      destinationMemberId: DESKTOP,
      destinationThread: { mode: "code", threadId: NEW_THREAD },
      keptWorktree: "/w/octant-moved-out",
    });
  });

  it("refuses to continue without the provider kind the thread ran on, or without the branch's note", async () => {
    const noProvider = world({ resolveProvider: () => undefined });
    await noProvider.desktop.receiveNotice(noProvider.signed(notice));
    expect(
      await noProvider.desktop.continueHandover({
        handoverId: HANDOVER as never,
        projectId: PROJECT as never,
      }),
    ).toEqual({ status: "refused", reason: "no-matching-provider" });

    const noNote = world({ readNote: async () => undefined });
    await noNote.desktop.receiveNotice(noNote.signed(notice));
    expect(
      await noNote.desktop.continueHandover({
        handoverId: HANDOVER as never,
        projectId: PROJECT as never,
      }),
    ).toEqual({ status: "refused", reason: "transfer-failed" });
    expect(noNote.created).toEqual([]);
  });
});
