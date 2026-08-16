import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeWorkPromotionCommand,
  decodeWorkPromotionFrame,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeWindowId,
  type CodeThreadId,
  type WorkPromotionCommand,
  type WorkPromotionFrame,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { WorkPromotionEventStoreError } from "./workPromotionEventStore";
import { WorkPromotionProjection } from "./workPromotionProjection";
import {
  WorkPromotionService,
  type WorkPromotionCodeThreadPort,
  type WorkPromotionProjectPort,
} from "./workPromotionService";

const ids = {
  proposal: decodeWorkPromotionProposalId("11111111-1111-4111-8111-111111111111"),
  origin: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  target: decodeProjectId("33333333-3333-4333-8333-333333333333"),
  codeThread: "44444444-4444-4444-8444-444444444444" as CodeThreadId,
  provider: decodeProviderInstanceId("55555555-5555-4555-8555-555555555555"),
  actor: "66666666-6666-4666-8666-666666666666",
  window: decodeWindowId("77777777-7777-4777-8777-777777777777"),
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const clockNow = "2026-07-22T08:00:00.000Z";
const clockLater = "2026-07-22T08:05:00.000Z";

const selectedContext = {
  summary: "Refactor the report generator into a small CLI",
  artifactRefs: ["opaque-artifact-token-1"],
} as const;

const deliveryTarget = {
  branchIntent: "feature/report-cli",
  remoteName: "origin",
  proposedBaseRepository: "git@github.com:example/repo.git",
  proposedBaseBranch: "main",
  outcomeKind: "opened-pr",
  confirmedAt: clockLater,
} as const;

interface TestHarness {
  service: WorkPromotionService;
  projection: WorkPromotionProjection;
  codeThreadPort: WorkPromotionCodeThreadPort & {
    creations: Array<{
      proposalId: typeof ids.proposal;
      originArtifactRefs: ReadonlyArray<string>;
      permissionPersistence: string;
    }>;
    cancellations: Array<{ proposalId: typeof ids.proposal; codeThreadId: CodeThreadId }>;
    fail: boolean;
  };
  eventStore: {
    append: (input: { frame: WorkPromotionFrame }) => WorkPromotionFrame;
    conflictNext: boolean;
    replayAll: () =>
      | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkPromotionFrame> }
      | { readonly status: "snapshot-required"; readonly reason: "scan-limit" };
    replayFrames: ReadonlyArray<WorkPromotionFrame>;
    replayAllStatus: "ok" | "snapshot-required";
  };
  clock: { ticks: number; now: () => string };
}

function createService(
  projects: WorkPromotionProjectPort = {
    projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
    workCanonicalRoot: () => "/work",
    resolveArtifactRefs: (_origin, refs) => refs,
  },
): TestHarness {
  const projection = new WorkPromotionProjection();
  const clock = { ticks: 0, now: () => (clock.ticks++ === 0 ? clockNow : clockLater) };
  const codeThreadPort: TestHarness["codeThreadPort"] = {
    creations: [],
    cancellations: [],
    fail: false,
    async createApprovalGatedThread(input) {
      if (codeThreadPort.fail) throw new Error("code thread unavailable");
      codeThreadPort.creations.push({
        proposalId: input.proposalId,
        originArtifactRefs: input.originArtifactRefs,
        permissionPersistence: input.permissionPersistence,
      });
      expect(input.authenticatedWindowId).toBe(ids.window);
      return { codeThreadId: ids.codeThread };
    },
    async cancelCodeThread(input) {
      codeThreadPort.cancellations.push({
        proposalId: input.proposalId,
        codeThreadId: input.codeThreadId,
      });
    },
  };
  const eventStore: TestHarness["eventStore"] = {
    conflictNext: false,
    replayFrames: [],
    replayAllStatus: "ok",
    append: (input) => {
      if (eventStore.conflictNext) {
        throw new WorkPromotionEventStoreError("invalid", "concurrency conflict");
      }
      eventStore.replayFrames = [...eventStore.replayFrames, input.frame];
      return input.frame;
    },
    replayAll: () =>
      eventStore.replayAllStatus === "snapshot-required"
        ? { status: "snapshot-required", reason: "scan-limit" }
        : { status: "ok", frames: eventStore.replayFrames },
  };
  const service = new WorkPromotionService({
    projects,
    codeThreads: codeThreadPort,
    projection,
    eventStore,
    actor,
    clock: clock.now,
    authenticatedWindowId: () => ids.window,
  });
  return { service, projection, codeThreadPort, eventStore, clock };
}

type ProposeCommand = Extract<WorkPromotionCommand, { kind: "propose-work-promotion" }>;
type ApproveCommand = Extract<WorkPromotionCommand, { kind: "approve-work-promotion" }>;
type TransitionCommand = Extract<
  WorkPromotionCommand,
  { kind: "dismiss-work-promotion" | "expire-work-promotion" }
>;

function proposeCommand(overrides?: {
  selectedContext?: { summary: string; artifactRefs: ReadonlyArray<string> };
}): ProposeCommand {
  const command = decodeWorkPromotionCommand({
    kind: "propose-work-promotion",
    proposalId: ids.proposal,
    originProjectId: ids.origin,
    targetCodeProjectId: ids.target,
    selectedContext: overrides?.selectedContext ?? selectedContext,
    proposedCodePermissionPersistence: "current-session",
  });
  return command as ProposeCommand;
}

function approveCommand(expectedVersion = 1): ApproveCommand {
  const command = decodeWorkPromotionCommand({
    kind: "approve-work-promotion",
    proposalId: ids.proposal,
    expectedVersion,
    providerInstanceId: ids.provider,
    modelId: "claude-sonnet-4",
    deliveryTarget,
  });
  return command as ApproveCommand;
}

function transitionCommand(
  kind: "dismiss-work-promotion" | "expire-work-promotion",
  expectedVersion = 1,
): TransitionCommand {
  const command = decodeWorkPromotionCommand({
    kind,
    proposalId: ids.proposal,
    expectedVersion,
  });
  return command as TransitionCommand;
}

describe("WorkPromotionService", () => {
  it("creates a proposed promotion with server-derived actor and timestamp", async () => {
    const { service, projection } = createService();
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.kind).toBe("work-promotion-proposed");
    if (result.result.kind !== "work-promotion-proposed") return;
    expect(result.result.proposal.status).toBe("proposed");
    expect(result.result.proposal.proposedCodeExecutionPolicy).toBe("approval-gated");
    expect(result.result.proposal.linkedCodeThreadId).toBeUndefined();
    expect(result.result.proposal.proposedBy).toEqual({ kind: "local-user", actorId: ids.actor });
    expect(result.result.proposal.proposedAt).toBe(clockNow);
    expect(projection.lookup(ids.proposal)?.proposal.status).toBe("proposed");
  });

  it("approves a proposed promotion and creates a linked approval-gated Code thread", async () => {
    const { service, projection, codeThreadPort } = createService();
    await service.execute(proposeCommand());
    const result = await service.execute(approveCommand(1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.kind).toBe("work-promotion-approved");
    if (result.result.kind !== "work-promotion-approved") return;
    expect(result.result.linkedCodeThreadId).toBe(ids.codeThread);
    expect(result.result.proposal.status).toBe("approved");
    expect(result.result.proposal.linkedCodeThreadId).toBe(ids.codeThread);
    expect(result.result.proposal.decidedAt).toBe(clockLater);
    expect(codeThreadPort.creations).toHaveLength(1);
    expect(codeThreadPort.creations[0]?.proposalId).toBe(ids.proposal);
    expect(codeThreadPort.creations[0]?.permissionPersistence).toBe("current-session");
    expect(codeThreadPort.creations[0]?.originArtifactRefs).toEqual(["opaque-artifact-token-1"]);
    expect(projection.lookup(ids.proposal)?.proposal.status).toBe("approved");
  });

  it("rejects approval when the renderer target is stale", async () => {
    const harness = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => "/work",
      resolveArtifactRefs: (_origin, refs) => refs,
      resolveDeliveryTarget: () => ({
        ...deliveryTarget,
        branchIntent: "feature/server-authoritative",
        confirmedAt: clockLater as never,
      }),
    });
    await harness.service.execute(proposeCommand());

    const result = await harness.service.execute(approveCommand(1));

    expect(result).toEqual({
      status: "failure",
      failure: {
        code: "stale",
        message: "The Code delivery target is stale; reload the promotion context.",
      },
    });
    expect(harness.codeThreadPort.creations).toHaveLength(0);
  });

  it("dismisses a proposed promotion without creating a Code thread", async () => {
    const { service, projection, codeThreadPort } = createService();
    await service.execute(proposeCommand());
    const result = await service.execute(transitionCommand("dismiss-work-promotion", 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.kind).toBe("work-promotion-dismissed");
    if (result.result.kind !== "work-promotion-dismissed") return;
    expect(result.result.proposal.decidedAt).toBe(clockLater);
    expect(codeThreadPort.creations).toHaveLength(0);
    expect(projection.lookup(ids.proposal)?.proposal.status).toBe("dismissed");
  });

  it("expires a proposed promotion without creating a Code thread", async () => {
    const { service, projection } = createService();
    await service.execute(proposeCommand());
    const result = await service.execute(transitionCommand("expire-work-promotion", 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.kind).toBe("work-promotion-expired");
    expect(projection.lookup(ids.proposal)?.proposal.status).toBe("expired");
  });

  it("denies approval of an already-approved promotion (no second Code thread)", async () => {
    const { service, codeThreadPort } = createService();
    await service.execute(proposeCommand());
    await service.execute(approveCommand(1));
    const result = await service.execute(approveCommand(2));
    expect(result.status).toBe("failure");
    expect(codeThreadPort.creations).toHaveLength(1);
  });

  it("denies approval of a dismissed promotion", async () => {
    const { service, codeThreadPort } = createService();
    await service.execute(proposeCommand());
    await service.execute(transitionCommand("dismiss-work-promotion", 1));
    const result = await service.execute(approveCommand(2));
    expect(result.status).toBe("failure");
    expect(codeThreadPort.creations).toHaveLength(0);
  });

  it("rejects a stale approval whose expected version does not match", async () => {
    const { service } = createService();
    await service.execute(proposeCommand());
    const result = await service.execute(approveCommand(99));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("stale");
  });

  it("rejects a proposal whose origin is not a Work Project", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "chat" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => undefined,
      resolveArtifactRefs: (_origin, refs) => refs,
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("rejects a proposal whose target is not a Code Project", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "work" : "unknown"),
      workCanonicalRoot: () => "/work",
      resolveArtifactRefs: (_origin, refs) => refs,
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
  });

  it("rejects a proposal whose selected context leaks the canonical Work root", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => "workdata",
      resolveArtifactRefs: (_origin, refs) => refs,
    });
    const result = await service.execute(
      proposeCommand({
        selectedContext: {
          summary: "the workdata folder should move to Code",
          artifactRefs: ["opaque-artifact-token-1"],
        },
      }),
    );
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("rejects a duplicate proposal id", async () => {
    const { service } = createService();
    await service.execute(proposeCommand());
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
  });

  it("rejects approval when the linked Code thread cannot be created", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    harness.codeThreadPort.fail = true;
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unavailable");
  });

  it("rejects approval when the event store reports a concurrency conflict", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    harness.eventStore.conflictNext = true;
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
  });

  it("rejects a transition on an unknown proposal", async () => {
    const { service } = createService();
    const result = await service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("not-found");
  });

  it("rejects a system actor from proposing a promotion", async () => {
    const projection = new WorkPromotionProjection();
    const systemActor = Schema.decodeUnknownSync(EventActor)({
      kind: "system",
      actorId: ids.actor,
    });
    const service = new WorkPromotionService({
      projects: {
        projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
        workCanonicalRoot: () => "/work",
        resolveArtifactRefs: (_origin, refs) => refs,
      },
      codeThreads: {
        async createApprovalGatedThread() {
          return { codeThreadId: ids.codeThread };
        },
        async cancelCodeThread() {},
      },
      projection,
      eventStore: {
        append: (input) => input.frame,
        replayAll: () => ({ status: "ok", frames: [] }),
      },
      actor: systemActor,
      clock: () => clockNow,
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("allows a system actor to expire a proposed promotion", async () => {
    const projection = new WorkPromotionProjection();
    const systemActor = Schema.decodeUnknownSync(EventActor)({
      kind: "system",
      actorId: ids.actor,
    });
    const eventStore: TestHarness["eventStore"] = {
      conflictNext: false,
      replayFrames: [],
      replayAllStatus: "ok",
      append: (input) => input.frame,
      replayAll: () => ({ status: "ok", frames: eventStore.replayFrames }),
    };
    const service = new WorkPromotionService({
      projects: {
        projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
        workCanonicalRoot: () => "/work",
        resolveArtifactRefs: (_origin, refs) => refs,
      },
      codeThreads: {
        async createApprovalGatedThread() {
          return { codeThreadId: ids.codeThread };
        },
        async cancelCodeThread() {},
      },
      projection,
      eventStore,
      actor: systemActor,
      clock: () => clockLater,
    });
    // Seed the projection with a proposed frame using a local-user service first.
    const userHarness = createService();
    await userHarness.service.execute(proposeCommand());
    const seededEntry = userHarness.projection.lookup(ids.proposal);
    if (seededEntry === undefined) throw new Error("seed proposal missing");
    projection.apply({ kind: "proposed", proposal: seededEntry.proposal });

    const result = await service.execute(transitionCommand("expire-work-promotion", 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.kind).toBe("work-promotion-expired");
    expect(projection.lookup(ids.proposal)?.proposal.status).toBe("expired");
  });

  it("rejects a proposal when the Work canonical root is unavailable (fail closed)", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => undefined,
      resolveArtifactRefs: (_origin, refs) => refs,
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("rejects a proposal whose artifact refs do not resolve to the origin Project", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => "/work",
      resolveArtifactRefs: (_origin, refs) => refs.slice(0, 0),
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("surfaces a non-conflict journal write failure as unavailable, not conflict", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    harness.eventStore.append = () => {
      throw new WorkPromotionEventStoreError("journal-mismatch", "committed event does not match");
    };
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unavailable");
  });

  it("rejects a proposal when the Work canonical root is an empty string (fail closed)", async () => {
    const { service } = createService({
      projectType: (id) => (id === ids.origin ? "work" : id === ids.target ? "code" : "unknown"),
      workCanonicalRoot: () => "",
      resolveArtifactRefs: (_origin, refs) => refs,
    });
    const result = await service.execute(proposeCommand());
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unauthorized");
  });

  it("cancels the created Code thread when a concurrent dismiss wins the approval race", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    // Simulate a concurrent dismiss winning: the projection is updated to
    // dismissed before the losing approve's append fails.
    harness.eventStore.append = () => {
      const dismissed = decodeWorkPromotionFrame({
        kind: "dismissed",
        proposal: {
          ...harness.projection.lookup(ids.proposal)!.proposal,
          status: "dismissed",
          decidedAt: clockLater,
          version: 2,
        },
      });
      harness.projection.apply(dismissed);
      throw new WorkPromotionEventStoreError("invalid", "concurrency conflict");
    };
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
    expect(harness.codeThreadPort.creations).toHaveLength(1);
    expect(harness.codeThreadPort.cancellations).toHaveLength(1);
    expect(harness.codeThreadPort.cancellations[0]?.codeThreadId).toBe(ids.codeThread);
  });

  it("does not cancel the Code thread when a transient journal outage fails the append", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    // Simulate a transient journal outage: the append fails but the
    // proposal is still proposed (no concurrent terminal transition).
    harness.eventStore.append = () => {
      throw new WorkPromotionEventStoreError("journal-mismatch", "committed event does not match");
    };
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("unavailable");
    expect(harness.codeThreadPort.creations).toHaveLength(1);
    // A retry must bind to the same idempotent thread, so no cancel.
    expect(harness.codeThreadPort.cancellations).toHaveLength(0);
  });

  it("does not cancel the Code thread when a concurrent approve wins the race", async () => {
    const harness = createService();
    await harness.service.execute(proposeCommand());
    // Simulate a concurrent approve winning: the projection is updated to
    // approved with the same codeThreadId before the losing append fails.
    harness.eventStore.append = (input) => {
      harness.projection.apply(input.frame);
      throw new WorkPromotionEventStoreError("invalid", "concurrency conflict");
    };
    const result = await harness.service.execute(approveCommand(1));
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.failure.code).toBe("conflict");
    expect(harness.codeThreadPort.creations).toHaveLength(1);
    expect(harness.codeThreadPort.cancellations).toHaveLength(0);
  });

  it("hydrates the projection from the journal after a restart", async () => {
    // Simulate a restart: a fresh projection and service, but the event
    // store still has the journaled frames from before restart.
    const first = createService();
    await first.service.execute(proposeCommand());
    const replayFrames = [...first.eventStore.replayFrames];

    const second = createService();
    expect(second.projection.lookup(ids.proposal)).toBeUndefined();
    second.eventStore.replayFrames = replayFrames;
    second.service.hydrate();
    const entry = second.projection.lookup(ids.proposal);
    expect(entry).toBeDefined();
    expect(entry?.proposal.status).toBe("proposed");
  });

  it("throws when hydration exceeds the journal scan cap (fail closed)", async () => {
    const harness = createService();
    harness.eventStore.replayAllStatus = "snapshot-required";
    expect(() => harness.service.hydrate()).toThrow();
  });
});
