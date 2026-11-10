import { describe, expect, it } from "vitest";
import {
  MAX_WAKE_HOPS,
  coordinatorNoticeFor,
  coordinatorStartingFor,
  decideCoordinatorRole,
  decideCoordinatorStart,
  decideMessageWake,
} from "./coordinatorPolicy";
import { threadsToolOperations } from "./siblingThreadPolicy";

const thread = {
  lifecycle: "active",
  coordinator: false,
  startedByCoordinator: false,
  projectActive: true,
} as const;

const coordinator = {
  coordinator: true,
  lifecycle: "active",
  level: "auto-accept-edits",
  marked: false,
} as const;

const start = {
  caller: coordinator,
  profileAllowsStart: true,
  starting: "start-without-asking",
  openWorkers: 0,
  openWorkerLimit: undefined,
  startsInLastHour: 0,
  requestedLevel: undefined,
} as const;

describe("coordinator role", () => {
  it("refuses to make a worker or a fifth thread of a Project a coordinator", () => {
    expect(
      decideCoordinatorRole({
        thread: { ...thread, startedByCoordinator: true },
        make: true,
        coordinatorsInProject: 0,
      }).status,
    ).toBe("refused");
    expect(decideCoordinatorRole({ thread, make: true, coordinatorsInProject: 4 }).status).toBe(
      "refused",
    );
    expect(decideCoordinatorRole({ thread, make: true, coordinatorsInProject: 3 }).status).toBe(
      "allowed",
    );
  });

  it("always lets a person stop a coordinator, even an archived one", () => {
    expect(
      decideCoordinatorRole({
        thread: { ...thread, coordinator: true, lifecycle: "archived" },
        make: false,
        coordinatorsInProject: 1,
      }).status,
    ).toBe("allowed");
  });
});

describe("starting workers", () => {
  it("refuses a thread that is not a coordinator and a coordinator set to Plan", () => {
    expect(
      decideCoordinatorStart({ ...start, caller: { ...coordinator, coordinator: false } }),
    ).toMatchObject({ status: "refused", reason: "unauthorized" });
    expect(
      decideCoordinatorStart({ ...start, caller: { ...coordinator, level: "plan" } }),
    ).toMatchObject({ status: "refused", reason: "policy" });
  });

  it("starts at the coordinator's level unless a lower one is named, never a higher one", () => {
    expect(decideCoordinatorStart(start)).toEqual({ status: "start", level: "auto-accept-edits" });
    expect(decideCoordinatorStart({ ...start, requestedLevel: "approval-gated" })).toEqual({
      status: "start",
      level: "approval-gated",
    });
    expect(decideCoordinatorStart({ ...start, requestedLevel: "full-access" })).toMatchObject({
      status: "refused",
      reason: "policy",
    });
  });

  it("never starts a worker at Full access from a marked coordinator", () => {
    const marked = { ...coordinator, level: "full-access", marked: true } as const;
    expect(decideCoordinatorStart({ ...start, caller: marked })).toEqual({
      status: "start",
      level: "auto-accept-edits",
    });
    expect(
      decideCoordinatorStart({ ...start, caller: marked, requestedLevel: "full-access" }),
    ).toMatchObject({ status: "refused", reason: "policy" });
  });

  it("holds the open-worker and hourly bounds and turns a restricted start into a proposal", () => {
    expect(decideCoordinatorStart({ ...start, openWorkers: 6 })).toMatchObject({
      reason: "limit-reached",
    });
    expect(decideCoordinatorStart({ ...start, openWorkers: 6, openWorkerLimit: 8 }).status).toBe(
      "start",
    );
    expect(decideCoordinatorStart({ ...start, startsInLastHour: 12 })).toMatchObject({
      reason: "rate-limited",
    });
    expect(decideCoordinatorStart({ ...start, starting: "propose-for-approval" }).status).toBe(
      "propose",
    );
  });

  it("lets a Project's own choice win over Settings", () => {
    expect(
      coordinatorStartingFor({
        settings: "start-without-asking",
        overrides: { p: "propose-for-approval" } as never,
        projectId: "p",
      }),
    ).toBe("propose-for-approval");
    expect(
      coordinatorStartingFor({ settings: undefined, overrides: undefined, projectId: "p" }),
    ).toBe("start-without-asking");
  });
});

describe("waking for a message", () => {
  const idle = {
    messageWake: true,
    coordinatorThreadId: undefined,
    coordinatorWakeOff: false,
    idle: true,
  };
  const wake = {
    recipient: idle,
    senderThreadId: "sender",
    hop: 0,
    wakeTurnRunning: false,
    wakeTurnsInLastHour: 0,
  };

  it("wakes an idle thread whose switch is on, and only that", () => {
    expect(decideMessageWake(wake).status).toBe("wake");
    expect(decideMessageWake({ ...wake, recipient: { ...idle, messageWake: false } })).toEqual({
      status: "carry",
      reason: "switch-off",
    });
    expect(decideMessageWake({ ...wake, recipient: { ...idle, idle: false } })).toEqual({
      status: "carry",
      reason: "busy",
    });
  });

  it("wakes a worker for its own coordinator unless a person turned that off", () => {
    const worker = { ...idle, messageWake: false, coordinatorThreadId: "sender" };
    expect(decideMessageWake({ ...wake, recipient: worker }).status).toBe("wake");
    expect(
      decideMessageWake({ ...wake, recipient: { ...worker, coordinatorWakeOff: true } }).status,
    ).toBe("carry");
    expect(decideMessageWake({ ...wake, recipient: worker, senderThreadId: "other" }).status).toBe(
      "carry",
    );
  });

  it("stops two agents waking each other after three rounds and six turns an hour", () => {
    expect(decideMessageWake({ ...wake, hop: MAX_WAKE_HOPS })).toEqual({
      status: "carry",
      reason: "hops",
    });
    expect(decideMessageWake({ ...wake, wakeTurnsInLastHour: 6 })).toEqual({
      status: "carry",
      reason: "hourly",
    });
    expect(decideMessageWake({ ...wake, wakeTurnRunning: true }).status).toBe("carry");
  });

  it("notices a worker finishing, waiting, or Done, not starting to work", () => {
    expect(coordinatorNoticeFor("working", "idle")).toBe(true);
    expect(coordinatorNoticeFor("working", "waiting-for-person")).toBe(true);
    expect(coordinatorNoticeFor("idle", "done")).toBe(true);
    expect(coordinatorNoticeFor("idle", "working")).toBe(false);
    expect(coordinatorNoticeFor(undefined, "idle")).toBe(false);
  });
});

describe("the threads tool for a coordinator", () => {
  const code = {
    mode: "code",
    posture: "plan",
    profileAllowsRead: true,
    profileAllowsSend: true,
    profileAllowsBoard: true,
    messagingCarried: true,
    plannerThread: false,
  } as const;

  it("offers messaging and start by the coordinator's own level, though its turn runs in Plan", () => {
    expect(
      threadsToolOperations({
        ...code,
        coordinatorLevel: "approval-gated",
        profileAllowsStart: true,
      }),
    ).toEqual(["help", "list", "read", "wait", "send", "acknowledge", "receipts", "start"]);
    expect(
      threadsToolOperations({ ...code, coordinatorLevel: "plan", profileAllowsStart: true }),
    ).toEqual(["help", "list", "read", "wait"]);
    expect(threadsToolOperations({ ...code, profileAllowsStart: true })).not.toContain("start");
  });
});
