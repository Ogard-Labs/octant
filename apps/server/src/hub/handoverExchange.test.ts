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
import { HandoverClaims, ThreadHandovers } from "./threadHandovers";
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

function world(
  overrides: Partial<HandoverExchangeOptions> = {},
  laptopOverrides: Partial<HandoverExchangeOptions> = {},
) {
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
    readNote: async ({ handoverId }) => ({
      note: `Hand over: Fix the flaky test\n\nOctant-Handover: ${handoverId}`,
      commit: "c".repeat(40),
    }),
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
  laptop = new HandoverExchange({ ...base(DESKTOP), state: laptopState, ...laptopOverrides });
  const source = laptop;
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
  return { desktop, desktopState, laptop: source, laptopState, erased, created, notes, signed };
}

describe("continuing a handover on another computer", () => {
  it("starts the thread on a suffixed branch when the destination already has one of that name", async () => {
    const opened: Array<{
      readonly branch: string;
      readonly threadBranch: string;
      readonly commit: string;
    }> = [];
    const { desktop, signed } = world({
      branchTaken: async ({ branch }) => branch === "feature/flaky",
      createThread: async (input) => {
        opened.push({
          branch: input.branch,
          threadBranch: input.threadBranch,
          commit: input.commit,
        });
      },
    });
    await desktop.receiveNotice(signed(notice));

    expect(
      await desktop.continueHandover({
        handoverId: HANDOVER as never,
        projectId: PROJECT as never,
      }),
    ).toEqual({ status: "continued", thread: { mode: "code", threadId: NEW_THREAD } });
    // It still starts from the fetched handover branch, at the commit whose note was checked.
    expect(opened).toEqual([
      {
        branch: "feature/flaky",
        threadBranch: "feature/flaky-handover-88888888",
        commit: "c".repeat(40),
      },
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

  it("makes one thread when Continue handover is pressed twice at once, and answers both with it", async () => {
    let release: (() => void) | undefined;
    let made = 0;
    let ids = 0;
    const { desktop, signed } = world({
      uuid: () => `8888888${String(ids++)}-8888-4888-8888-888888888888`,
      createThread: async () => {
        made += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await desktop.receiveNotice(signed(notice));
    const request = { handoverId: HANDOVER as never, projectId: PROJECT as never };

    const first = desktop.continueHandover(request);
    const second = desktop.continueHandover(request);
    await expect.poll(() => release).toBeDefined();
    release?.();
    const answers = await Promise.all([first, second]);

    expect(made).toBe(1);
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.status).toBe("continued");
    // A later retry gets the same thread rather than a second one.
    expect(await desktop.continueHandover(request)).toEqual(answers[0]);
    expect(made).toBe(1);
  });

  it("refuses Take back here once the source has begun erasing a continued handover", async () => {
    const claims = new HandoverClaims();
    let finishErase: (() => void) | undefined;
    const { laptop, laptopState, signed } = world(
      {},
      {
        claims,
        source: {
          erase: async () => {
            await new Promise<void>((resolve) => {
              finishErase = resolve;
            });
            return { worktreeKept: false };
          },
          unfreeze: () => {},
        },
      },
    );
    const handovers = new ThreadHandovers({
      claims,
      source: {
        read: async () => ({ status: "missing" }),
        freeze: () => {},
        unfreeze: () => {},
        isFrozen: () => true,
      },
      code: {
        checkoutRoot: async () => undefined,
        provider: () => undefined,
        latest: async () => ({}),
      },
      record: { handoverStarted: () => {} },
      state: laptopState,
      originName: () => "Laptop",
      clock: () => "2026-11-08T13:00:00.000Z",
    });

    const erasing = laptop.receiveContinued(
      signed({ handoverId: HANDOVER, thread: { mode: "code", threadId: NEW_THREAD } }),
    );
    await expect.poll(() => finishErase).toBeDefined();
    expect(handovers.takeBack(HANDOVER)).toEqual({ status: "refused", reason: "busy" });

    finishErase?.();
    expect((await erasing).body).toEqual({ status: "erased" });
    expect(laptopState.load().handovers).toEqual([]);
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
