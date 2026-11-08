import { describe, expect, it } from "vitest";
import type {
  HostOwnerEntry,
  HubMemberId,
  HubRoster,
  PeerGrant,
  ProjectId,
  RosterMember,
  ThreadMoveId,
} from "@octant/contracts";
import { defaultHubGrant } from "./hubAndSpokesPolicy";
import {
  ACTIVATE_ANYWAY_AFTER_MS,
  authorizeMoveIn,
  decideMoveEligibility,
  defaultShutdownDestination,
  handoverBranch,
  mayActivateAnyway,
  mayRemoveMovedWorktree,
  normalizeRepositoryRemote,
  recoverSourceMove,
  SHUTDOWN_RECENT_WINDOW_MS,
  shutdownListing,
  startingShutdownChoice,
  type DestinationProject,
  type DestinationReading,
  type MovableThread,
} from "./hubThreadMovePolicy";

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const memberId = (n: number) => id(n) as HubMemberId;
const projectId = (n: number) => id(n) as ProjectId;
const moveId = id(9) as ThreadMoveId;
const key = (n: number) => String(n).repeat(64).slice(0, 64);

const member = (n: number, role: RosterMember["role"]): RosterMember => ({
  memberId: memberId(n),
  name: `member ${n}`,
  role,
  identityKeyFingerprint: key(n),
  listenerPin: key(n),
  privateNames: [],
  addresses: ["100.64.0.1"],
  owner: false,
});

const roster: HubRoster = {
  sequence: 4,
  members: [member(1, "hub"), member(3, "spoke"), member(4, "spoke")],
  standbyOrder: [],
  failoverAfterSeconds: 300,
};

const repository = "git@github.com:Ogard-Labs/octant.git";

const codeThread: MovableThread = {
  mode: "code",
  activity: "idle",
  delegated: false,
  repositoryRemotes: [repository],
};

const project = (n: number, mode: DestinationProject["mode"], remotes: string[] = []) => ({
  projectId: projectId(n),
  mode,
  repositoryRemotes: remotes,
});

const reachable: DestinationReading = {
  reachable: true,
  acceptsMoves: true,
  ownerThere: true,
  projects: [
    project(5, "code", ["https://github.com/ogard-labs/octant"]),
    project(6, "code", ["https://github.com/ogard-labs/other.git"]),
    project(7, "work"),
  ],
};

describe("repository remotes", () => {
  it("treats an SSH clone and an HTTPS clone of one repository as the same repository", () => {
    expect(normalizeRepositoryRemote("git@github.com:Ogard-Labs/octant.git")).toBe(
      normalizeRepositoryRemote("https://github.com/ogard-labs/octant/"),
    );
  });

  it("stays fast on a remote or a title made of a long run of one character", () => {
    const started = performance.now();
    expect(normalizeRepositoryRemote(`https://github.com/${"/".repeat(100_000)}a`)).toBe(
      "github.com/a",
    );
    expect(
      handoverBranch({
        currentBranch: undefined,
        defaultBranch: "main",
        threadTitle: `${"-".repeat(100_000)}x`,
        threadId: id(2),
      }),
    ).toBe("octant/handover/x-22222222");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps a self-hosted repository's path case and a non-default port as part of its identity", () => {
    expect(normalizeRepositoryRemote("ssh://git@git.example/team/Foo.git")).not.toBe(
      normalizeRepositoryRemote("ssh://git@git.example/team/foo.git"),
    );
    expect(normalizeRepositoryRemote("ssh://git@git.example:2222/team/foo.git")).not.toBe(
      normalizeRepositoryRemote("ssh://git@git.example:2223/team/foo.git"),
    );
    expect(normalizeRepositoryRemote("ssh://git@git.example:22/team/foo.git")).toBe(
      normalizeRepositoryRemote("git@git.example:team/foo.git"),
    );
    expect(normalizeRepositoryRemote("https://git.example:443/team/foo")).toBe(
      normalizeRepositoryRemote("https://git.example/team/foo.git"),
    );
  });

  it("refuses a Code destination bound to a same-named repository on another port", () => {
    const thread = {
      ...codeThread,
      repositoryRemotes: ["ssh://git@git.example:2222/team/app.git"],
    };
    const destination = {
      ...reachable,
      projects: [project(5, "code", ["ssh://git@git.example:2223/team/app.git"])],
    };
    expect(decideMoveEligibility({ thread, destination })).toEqual({
      status: "cannot-move",
      reason: "no-eligible-project",
    });
  });

  it("ignores credentials in a URL and refuses text that names no repository", () => {
    expect(normalizeRepositoryRemote("https://token@github.com/Ogard-Labs/octant.git")).toBe(
      "github.com/ogard-labs/octant",
    );
    expect(normalizeRepositoryRemote("")).toBeUndefined();
    expect(normalizeRepositoryRemote("not a remote")).toBeUndefined();
  });
});

describe("whether a thread can move", () => {
  it("offers a Code thread only Projects bound to a clone of its own repository", () => {
    const eligibility = decideMoveEligibility({ thread: codeThread, destination: reachable });
    expect(eligibility).toEqual({
      status: "eligible",
      projects: [reachable.projects[0]],
      waitsForTurn: false,
    });
  });

  it("refuses a Code thread whose repository the destination has no Project for", () => {
    const destination = {
      ...reachable,
      projects: [
        project(6, "code", ["https://github.com/ogard-labs/other.git"]),
        project(7, "work"),
      ],
    };
    expect(decideMoveEligibility({ thread: codeThread, destination })).toEqual({
      status: "cannot-move",
      reason: "no-eligible-project",
    });
  });

  it("lets a Chat thread move into no Project", () => {
    const chat: MovableThread = { ...codeThread, mode: "chat", repositoryRemotes: [] };
    expect(decideMoveEligibility({ thread: chat, destination: reachable })).toEqual({
      status: "eligible",
      projects: [],
      waitsForTurn: false,
    });
  });

  it("never moves a thread a peer delegated here, whatever the destination", () => {
    expect(
      decideMoveEligibility({ thread: { ...codeThread, delegated: true }, destination: reachable }),
    ).toEqual({ status: "cannot-move", reason: "delegated" });
  });

  it("names an unreachable or refusing destination before looking at its Projects", () => {
    expect(
      decideMoveEligibility({
        thread: codeThread,
        destination: { ...reachable, reachable: false, projects: [] },
      }),
    ).toEqual({ status: "cannot-move", reason: "destination-unreachable" });
    expect(
      decideMoveEligibility({
        thread: codeThread,
        destination: { ...reachable, acceptsMoves: false, projects: [] },
      }),
    ).toEqual({ status: "cannot-move", reason: "refused" });
    expect(
      decideMoveEligibility({
        thread: codeThread,
        destination: { ...reachable, ownerThere: false },
      }),
    ).toEqual({ status: "cannot-move", reason: "unlock-required" });
  });

  it("keeps a busy thread eligible but makes it wait for its turn", () => {
    const eligibility = decideMoveEligibility({
      thread: { ...codeThread, activity: "running" },
      destination: reachable,
    });
    expect(eligibility.status === "eligible" && eligibility.waitsForTurn).toBe(true);
  });
});

describe("whether a destination accepts a move", () => {
  const owners: HostOwnerEntry[] = [
    { memberId: memberId(3), identityKeyFingerprint: key(3), unlockKeyFingerprint: key(8) },
  ];
  const fullGrant: PeerGrant = { memberId: memberId(3), readStatus: true, moveIn: true };
  const ask = (overrides: Partial<Parameters<typeof authorizeMoveIn>[0]> = {}) =>
    authorizeMoveIn({
      host: "spoke",
      hubGrant: defaultHubGrant(),
      roster,
      grants: [fullGrant],
      owners,
      senderMemberId: memberId(3),
      ownerMemberId: memberId(3),
      ownerIdentityKeyFingerprint: key(3),
      unlock: "fresh",
      ...overrides,
    });

  it("accepts a move from a member with Move in, signed by a listed owner's fresh unlock", () => {
    expect(ask().status).toBe("allowed");
  });

  it("answers every missing permission in the same words", () => {
    const refused = { status: "refused", reason: "refused" };
    expect(ask({ grants: [{ ...fullGrant, moveIn: false }] })).toEqual(refused);
    expect(ask({ grants: [{ memberId: memberId(3), readStatus: true }] })).toEqual(refused);
    expect(ask({ hubGrant: { items: ["roster", "status"], actProjects: [] } })).toEqual(refused);
    expect(
      ask({ senderMemberId: memberId(7), grants: [{ ...fullGrant, memberId: memberId(7) }] }),
    ).toEqual(refused);
    expect(ask({ ownerMemberId: memberId(4), ownerIdentityKeyFingerprint: key(4) })).toEqual(
      refused,
    );
  });

  it("never lets an administration session cover a move", () => {
    expect(ask({ unlock: "session" })).toEqual({ status: "refused", reason: "unlock-required" });
    expect(ask({ unlock: "absent" })).toEqual({ status: "refused", reason: "unlock-required" });
  });
});

describe("Prepare to shut down", () => {
  it("starts a movable thread on Move and a busy one on Move after this turn", () => {
    expect(
      startingShutdownChoice({
        mode: "code",
        eligibility: { status: "eligible", projects: [], waitsForTurn: false },
      }),
    ).toEqual({ choice: "move", offers: ["move", "hand-over", "leave-here"] });
    expect(
      startingShutdownChoice({
        mode: "work",
        eligibility: { status: "eligible", projects: [], waitsForTurn: true },
      }),
    ).toEqual({
      choice: "move-after-turn",
      offers: ["move-after-turn", "stop-and-move", "leave-here"],
    });
  });

  it("starts a thread that cannot move on Leave here with its reason, never on a handover", () => {
    const code = startingShutdownChoice({
      mode: "code",
      eligibility: { status: "cannot-move", reason: "no-eligible-project" },
    });
    expect(code).toEqual({
      choice: "leave-here",
      offers: ["hand-over", "leave-here"],
      reason: "no-eligible-project",
    });
    const chat = startingShutdownChoice({
      mode: "chat",
      eligibility: { status: "cannot-move", reason: "destination-unreachable" },
    });
    expect(chat.offers).toEqual(["leave-here"]);
  });

  it("starts on the computer the person last moved to, then the hub, then the first online member", () => {
    const members = [
      { memberId: memberId(1), role: "hub" as const, online: true, takesThreads: true },
      { memberId: memberId(3), role: "spoke" as const, online: true, takesThreads: true },
      { memberId: memberId(4), role: "spoke" as const, online: false, takesThreads: true },
    ];
    expect(defaultShutdownDestination({ lastMovedTo: memberId(4), members })).toBe(memberId(4));
    expect(defaultShutdownDestination({ lastMovedTo: undefined, members })).toBe(memberId(1));
    const noHub = members.map((entry) =>
      entry.role === "hub" ? { ...entry, takesThreads: false } : entry,
    );
    expect(defaultShutdownDestination({ lastMovedTo: memberId(9), members: noHub })).toBe(
      memberId(3),
    );
    expect(
      defaultShutdownDestination({
        lastMovedTo: undefined,
        members: members.map((entry) => ({ ...entry, takesThreads: false })),
      }),
    ).toBeUndefined();
  });

  it("lists running and recent threads, folds quieter open ones, and leaves out closed ones", () => {
    const now = 100 * SHUTDOWN_RECENT_WINDOW_MS;
    const quiet = now - SHUTDOWN_RECENT_WINDOW_MS - 1;
    expect(
      shutdownListing({ thread: { activity: "running", open: false, lastTurnAt: quiet }, now }),
    ).toBe("listed");
    expect(
      shutdownListing({ thread: { activity: "idle", open: true, lastTurnAt: now - 1000 }, now }),
    ).toBe("listed");
    expect(
      shutdownListing({ thread: { activity: "idle", open: true, lastTurnAt: quiet }, now }),
    ).toBe("older");
    expect(
      shutdownListing({ thread: { activity: "idle", open: false, lastTurnAt: now - 1000 }, now }),
    ).toBe("absent");
  });
});

describe("recovering a move in progress", () => {
  it("erases the source only after the destination committed", () => {
    const thread = { mode: "code" as const, threadId: id(2) };
    expect(recoverSourceMove({ state: "committed", moveId, thread })).toEqual({ action: "erase" });
    expect(recoverSourceMove({ state: "arrived", moveId, thread })).toEqual({ action: "commit" });
    expect(recoverSourceMove({ state: "receiving", moveId, acknowledged: [] })).toEqual({
      action: "resume-transfer",
    });
    expect(recoverSourceMove({ state: "discarded", moveId })).toEqual({ action: "unfreeze" });
    expect(recoverSourceMove({ state: "unknown", moveId })).toEqual({ action: "unfreeze" });
  });

  it("offers Activate anyway only on an arriving thread after five minutes of silence", () => {
    expect(
      mayActivateAnyway({
        state: "arriving",
        lastHeardFromSourceAt: 0,
        now: ACTIVATE_ANYWAY_AFTER_MS,
      }),
    ).toBe(true);
    expect(
      mayActivateAnyway({
        state: "arriving",
        lastHeardFromSourceAt: 0,
        now: ACTIVATE_ANYWAY_AFTER_MS - 1,
      }),
    ).toBe(false);
    expect(
      mayActivateAnyway({
        state: "active",
        lastHeardFromSourceAt: 0,
        now: ACTIVATE_ANYWAY_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("keeps a worktree that still holds a refused or ignored file", () => {
    expect(mayRemoveMovedWorktree({ refusedFiles: 0, ignoredFiles: 0 })).toBe(true);
    expect(mayRemoveMovedWorktree({ refusedFiles: 1, ignoredFiles: 0 })).toBe(false);
    expect(mayRemoveMovedWorktree({ refusedFiles: 0, ignoredFiles: 3 })).toBe(false);
  });
});

describe("the handover branch", () => {
  it("commits to the thread's own branch", () => {
    expect(
      handoverBranch({
        currentBranch: "feature/move",
        defaultBranch: "main",
        threadTitle: "Move threads",
        threadId: id(2),
      }),
    ).toBe("feature/move");
  });

  it("never commits to the default branch or a detached head", () => {
    expect(
      handoverBranch({
        currentBranch: "main",
        defaultBranch: "main",
        threadTitle: "Fix the Café page!",
        threadId: id(2),
      }),
    ).toBe("octant/handover/fix-the-cafe-page-22222222");
    expect(
      handoverBranch({
        currentBranch: undefined,
        defaultBranch: "main",
        threadTitle: "???",
        threadId: id(2),
      }),
    ).toBe("octant/handover/22222222");
  });
});
