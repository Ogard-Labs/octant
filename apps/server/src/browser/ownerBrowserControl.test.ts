import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HubMemberId } from "@octant/contracts";
import {
  decodeOwnerBrowserControlId,
  decodeOwnerBrowserTarget,
  type OwnerBrowserInput,
} from "@octant/contracts/owner-browser";
import {
  OwnerBrowserControlService,
  type OwnerBrowserActor,
  type OwnerBrowserAuditFact,
} from "./ownerBrowserControl";

const member = Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001");
const target = decodeOwnerBrowserTarget({
  hostMemberId: member,
  threadId: "a7880000-0000-4000-8000-000000000002",
  contextId: "a7880000-0000-4000-8000-000000000003",
  targetVersion: "a".repeat(64),
  documentRevision: 1,
  origin: "https://fixture.invalid",
  profile: "private",
});
const controlId = decodeOwnerBrowserControlId("a7880000-0000-4000-8000-000000000004");

function fixture() {
  let now = 0;
  let current = true;
  let held = false;
  let privateHeld = false;
  let frameSequence = 0;
  const facts: OwnerBrowserAuditFact[] = [];
  const inputs: OwnerBrowserInput[] = [];
  const frame = Promise.withResolvers<void>();
  const frameStarted = Promise.withResolvers<void>();
  const inspection = Promise.withResolvers<void>();
  const inspected = Promise.withResolvers<void>();
  const claim = Promise.withResolvers<void>();
  const claimStarted = Promise.withResolvers<void>();
  let delayInspection = false;
  let delayClaim = false;
  let nativeController = false;
  let releaseFails = false;
  let releaseThrows = false;
  let inputFails = false;
  let delayFrame = false;
  const actor: OwnerBrowserActor = {
    principal: { kind: "owner-unlock", memberId: member },
    name: "Owner fixture",
    freshOwnUnlock: true,
    current: () => current,
    unlockDeadline: 60_000,
  };
  const service = new OwnerBrowserControlService({
    now: () => now,
    timestamp: () => "2026-11-04T12:00:00.000Z",
    uuid: () => controlId,
    audit: (fact) => {
      facts.push(fact);
    },
    host: {
      authorityCurrent: () => current,
      targets: async () => [{ target, threadTitle: "Synthetic Code task" }],
      inspect: async () => {
        if (delayInspection) {
          delayInspection = false;
          inspected.resolve();
          await inspection.promise;
        }
        return current ? target : undefined;
      },
      privateHeld: () => privateHeld,
      claim: async () => {
        claimStarted.resolve();
        if (delayClaim) await claim.promise;
        held = true;
        nativeController = true;
        return true;
      },
      frame: async () => {
        frameStarted.resolve();
        if (delayFrame) await frame.promise;
        return {
          status: "frame",
          frame: {
            sequence: ++frameSequence,
            documentRevision: 1,
            width: 1,
            height: 1,
            dataUrl: "data:image/jpeg;base64,AA==",
          },
        };
      },
      input: async (_target, _control, _sequence, _frame, input) => {
        inputs.push(input);
        if (inputFails) throw new Error("Synthetic lost input reply");
        return { status: "input", effect: "completed" };
      },
      release: async (_target, _control, disposition) => {
        if (releaseThrows) throw new Error("Synthetic unavailable native broker");
        if (releaseFails) return { status: "refused" };
        nativeController = false;
        if (disposition === "hand-back") held = false;
        return { status: "released" };
      },
    },
  });
  return {
    service,
    actor,
    facts,
    inputs,
    frameStarted: frameStarted.promise,
    inspected: inspected.promise,
    claimStarted: claimStarted.promise,
    nativeController: () => nativeController,
    held: () => held,
    expire: () => {
      now = 60_000;
    },
    revoke: () => {
      current = false;
    },
    private: (value: boolean) => {
      privateHeld = value;
    },
    delayed: () => {
      delayFrame = true;
    },
    resolveFrame: () => frame.resolve(),
    delayInspection: () => {
      delayInspection = true;
    },
    resolveInspection: () => inspection.resolve(),
    delayClaim: () => {
      delayClaim = true;
    },
    resolveClaim: () => claim.resolve(),
    failRelease: () => {
      releaseFails = true;
    },
    throwRelease: () => {
      releaseThrows = true;
    },
    failInput: () => {
      inputFails = true;
    },
  };
}

describe("owner Browser controller", () => {
  it("keeps the person hold after expiry and refuses stale or replayed input without auditing typed values", async () => {
    const f = fixture();
    expect((await f.service.execute(f.actor, { kind: "take-over", target })).status).toBe(
      "controlled",
    );
    const read = await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 });
    expect(read.status).toBe("frame");
    expect(
      (
        await f.service.execute(f.actor, {
          kind: "input",
          controlId,
          sequence: 2,
          expectedFrame: 1,
          input: { kind: "type", text: "synthetic-private-text" },
        })
      ).status,
    ).toBe("input");
    expect(
      (
        await f.service.execute(f.actor, {
          kind: "input",
          controlId,
          sequence: 2,
          expectedFrame: 1,
          input: { kind: "type", text: "replay" },
        })
      ).status,
    ).toBe("refused");
    expect(f.inputs).toHaveLength(1);
    expect(JSON.stringify(f.facts)).not.toContain("synthetic-private-text");
    expect(
      f.facts.every(
        (fact) =>
          fact.principal.kind === "owner-unlock" &&
          String(fact.principal.memberId) === String(member),
      ),
    ).toBe(true);
    f.expire();
    expect(
      (await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 3 })).status,
    ).toBe("refused");
    expect(f.held()).toBe(true);
    await f.service.close();
  });

  it("withholds a delayed person frame after owner revocation and never hands the page back as cancellation", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    f.delayed();
    const result = f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 });
    await f.frameStarted;
    f.revoke();
    f.resolveFrame();
    expect((await result).status).toBe("refused");
    expect(f.held()).toBe(true);
    await f.service.close();
  });

  it("refuses an inspected second request while the first frame still owns the controller", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    f.delayInspection();
    const second = f.service.execute(f.actor, { kind: "frame", controlId, sequence: 2 });
    await f.inspected;
    f.delayed();
    const first = f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 });
    await f.frameStarted;
    f.resolveInspection();
    expect(await second).toEqual({ status: "refused", reason: "controller-busy" });
    f.resolveFrame();
    expect((await first).status).toBe("frame");
    await f.service.close();
  });

  it("releases its own late native claim after close without releasing the person hold", async () => {
    const f = fixture();
    f.delayClaim();
    const claim = f.service.execute(f.actor, { kind: "take-over", target });
    await f.claimStarted;
    await f.service.close();
    f.resolveClaim();
    expect((await claim).status).toBe("refused");
    expect(f.nativeController()).toBe(false);
    expect(f.held()).toBe(true);
  });

  it("keeps expiry cleanup rejection from escaping the service", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    f.throwRelease();
    f.expire();
    expect(
      (await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 })).status,
    ).toBe("refused");
    await f.service.close();
    expect(f.held()).toBe(true);
  });

  it("does not restore an old controller when native stop cannot be confirmed", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    f.failRelease();
    expect(await f.service.execute(f.actor, { kind: "stop", controlId, sequence: 1 })).toEqual({
      status: "refused",
      reason: "unavailable",
    });
    expect(
      (await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 })).status,
    ).toBe("refused");
    expect(f.held()).toBe(true);
    await f.service.close();
  });

  it("requires a fresh frame after a lost input reply and does not claim an unconfirmed handback", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 });
    f.failInput();
    expect(
      await f.service.execute(f.actor, {
        kind: "input",
        controlId,
        sequence: 2,
        expectedFrame: 1,
        input: { kind: "press", key: "Enter" },
      }),
    ).toEqual({ status: "input", effect: "possible", nextSequence: 3 });
    expect(
      await f.service.execute(f.actor, {
        kind: "input",
        controlId,
        sequence: 3,
        expectedFrame: 1,
        input: { kind: "press", key: "Enter" },
      }),
    ).toEqual({ status: "refused", reason: "stale-frame" });
    expect(f.inputs).toHaveLength(1);
    f.failRelease();
    expect(await f.service.execute(f.actor, { kind: "hand-back", controlId, sequence: 3 })).toEqual(
      { status: "refused", reason: "unavailable" },
    );
    expect(f.held()).toBe(true);
    await f.service.close();
  });

  it("stops a pending frame without resuming the agent and cannot lend stop authority to another owner device", async () => {
    const f = fixture();
    await f.service.execute(f.actor, { kind: "take-over", target });
    const otherMember = Schema.decodeUnknownSync(HubMemberId)(
      "a7880000-0000-4000-8000-000000000099",
    );
    expect(
      (
        await f.service.execute(
          { ...f.actor, principal: { kind: "owner-unlock", memberId: otherMember } },
          { kind: "stop", controlId, sequence: 1 },
        )
      ).status,
    ).toBe("refused");
    f.delayed();
    const pending = f.service.execute(f.actor, { kind: "frame", controlId, sequence: 1 });
    await f.frameStarted;
    expect(await f.service.execute(f.actor, { kind: "stop", controlId, sequence: 1 })).toEqual({
      status: "released",
    });
    f.resolveFrame();
    expect((await pending).status).toBe("refused");
    expect(f.held()).toBe(true);
    expect(
      (await f.service.execute(f.actor, { kind: "frame", controlId, sequence: 2 })).status,
    ).toBe("refused");
    await f.service.close();
  });
});
