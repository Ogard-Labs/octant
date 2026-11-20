import { describe, expect, it } from "vitest";
import type { HubMemberId, ProjectId, RosterMember, ThreadMoveId } from "@octant/contracts";
import { fullMemberPeerGrant } from "./hubAndSpokesPolicy";
import {
  ACTIVATE_ANYWAY_AFTER_MS,
  defaultShutdownDestination,
  handoverBranch,
  mayActivateAnyway,
  mayRemoveMovedWorktree,
  normalizeRepositoryRemote,
  peerGrantAllowsMoveIn,
  recoverSourceMove,
  SHUTDOWN_RECENT_WINDOW_MS,
  shutdownListing,
  startingShutdownChoice,
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

  it("names a repository on the same disk by its path", () => {
    expect(normalizeRepositoryRemote("/srv/git/app.git")).toBe(
      normalizeRepositoryRemote("file:///srv/git/app"),
    );
    expect(normalizeRepositoryRemote("/srv/git/App.git")).not.toBe(
      normalizeRepositoryRemote("/srv/git/app.git"),
    );
  });

  it("ignores credentials in a URL and refuses text that names no repository", () => {
    expect(normalizeRepositoryRemote("https://token@github.com/Ogard-Labs/octant.git")).toBe(
      "github.com/ogard-labs/octant",
    );
    expect(normalizeRepositoryRemote("")).toBeUndefined();
    expect(normalizeRepositoryRemote("not a remote")).toBeUndefined();
  });
});

describe("whether a peer grant allows Move in", () => {
  it("reads Move in as on for a full member whose grant was stored before Move in existed", () => {
    const { moveIn: _absent, ...stored } = fullMemberPeerGrant(member(3, "spoke"));
    expect(peerGrantAllowsMoveIn(stored)).toBe(true);
  });

  it("keeps Move in off for a grant the person narrowed, turned off, or held until confirmed", () => {
    const { moveIn: _absent, ...stored } = fullMemberPeerGrant(member(3, "spoke"));
    const delegation = stored.delegation;
    if (delegation === undefined) throw new Error("A full member delegates.");
    expect(peerGrantAllowsMoveIn({ ...stored, moveIn: false })).toBe(false);
    expect(
      peerGrantAllowsMoveIn({ ...stored, delegation: { ...delegation, modes: ["work"] } }),
    ).toBe(false);
    expect(
      peerGrantAllowsMoveIn({ ...stored, delegation: { ...delegation, projects: [projectId(5)] } }),
    ).toBe(false);
    expect(peerGrantAllowsMoveIn({ memberId: memberId(3), readStatus: true })).toBe(false);
    expect(peerGrantAllowsMoveIn(fullMemberPeerGrant(member(4, "guest")))).toBe(false);
  });
});

describe("Prepare to shut down", () => {
  it("starts a movable thread on Move and a busy one on Move after this turn", () => {
    expect(
      startingShutdownChoice({
        mode: "code",
        eligibility: { status: "eligible", projects: [], waitsForTurn: false },
      }),
    ).toEqual({ choice: "move", offers: ["move", "leave-here"] });
    // Hand over is for a Code thread that cannot move; one that can moves properly.
    expect(
      startingShutdownChoice({
        mode: "code",
        eligibility: { status: "eligible", projects: [], waitsForTurn: true },
      }),
    ).toEqual({
      choice: "move-after-turn",
      offers: ["move-after-turn", "stop-and-move", "leave-here"],
    });
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
