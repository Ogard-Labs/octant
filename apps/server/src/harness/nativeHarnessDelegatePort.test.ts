import { describe, expect, it } from "vitest";
import { createNativeHarnessDelegatePort } from "./nativeHarnessDelegatePort";

const scope = {
  parentThreadId: "00000000-0000-4000-8000-000000000020",
  windowId: "window-1",
  mode: "code" as const,
  lead: {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: "big",
  } as never,
};

function port(
  posture: "off" | "automatic",
  admitted: unknown[] = [],
  overrides: {
    readonly persistence?: Parameters<typeof createNativeHarnessDelegatePort>[0]["persistence"];
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly sessionStatus?: string;
  } = {},
) {
  return createNativeHarnessDelegatePort(
    {
      admission: {
        persistence: { getByRequestId: () => undefined },
        orchestration: {
          admit: () => {
            throw new Error("admit must not run");
          },
        },
        settings: { current: () => ({ creationPosture: posture }) },
        providerReadiness: { isReady: () => true },
        uuid: () => "00000000-0000-4000-8000-000000000099",
        authorizeCreation: () => {
          admitted.push("authorized");
          return undefined;
        },
        nativeEvidence: () => ({
          claimedNativeSupport: "unsupported",
          workspace: false,
          authority: false,
          observability: false,
          cancellation: false,
          steering: false,
          recovery: false,
        }),
      },
      orchestration: {
        start: () => {
          throw new Error("start must not run");
        },
      },
      persistence: overrides.persistence ?? {
        parentSummary: () => [],
        resultText: () => undefined,
        getById: () => undefined,
      },
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
      router: { resolve: () => ({ kind: "unroutable" }) as never },
      sessions: {
        ensure: () => ({}) as never,
        recordRouteDecision: () => undefined,
        read: () =>
          overrides.sessionStatus === undefined
            ? undefined
            : ({ session: { status: overrides.sessionStatus } } as never),
      },
      uuid: () => "00000000-0000-4000-8000-000000000098",
    },
    scope,
  );
}

describe("native harness delegate port", () => {
  it("refuses to start a child while children are off, without consulting authority", async () => {
    const touched: unknown[] = [];
    const outcome = await port("off", touched).start({
      role: "research",
      task: "Look",
      includeParentContext: false,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "creation-posture-off" });
    expect(touched).toEqual([]);
  });

  it("starts no new helper while the run is paused, even with helpers on", async () => {
    for (const sessionStatus of ["paused-by-user", "paused-by-advisor", "recovery-required"]) {
      const outcome = await port("automatic", [], { sessionStatus }).start({
        role: "research",
        task: "Look",
        includeParentContext: false,
      });
      expect(outcome).toMatchObject({ status: "refused", reason: "session-paused" });
    }
  });

  it("admits through the shared path under Automatic and reports its refusal honestly", async () => {
    const touched: unknown[] = [];
    const outcome = await port("automatic", touched).start({
      role: "research",
      task: "Look",
      includeParentContext: false,
    });
    expect(touched).toEqual(["authorized"]);
    expect(outcome).toMatchObject({ status: "refused", reason: "unauthorized" });
  });

  it("only collects a child that belongs to this thread and has finished", async () => {
    const subject = port("automatic");
    expect(await subject.collect("00000000-0000-4000-8000-000000000050")).toEqual({
      status: "refused",
      reason: "run-not-found",
    });
  });

  it("waits until the named children finished, and says where they stand when time runs out", async () => {
    const first = "00000000-0000-4000-8000-000000000061";
    const joined = "00000000-0000-4000-8000-000000000062";
    const statuses: Record<string, string> = { [first]: "running", [joined]: "waiting" };
    let clock = 0;
    const subject = port("automatic", [], {
      persistence: {
        parentSummary: () =>
          [first, joined].map((runId) => ({
            runId,
            role: "research",
            task: "Look",
            lifecycleStatus: statuses[runId],
          })) as never,
        resultText: () => undefined,
        getById: (runId) =>
          (String(runId) === joined
            ? { dependsOn: [first], recoveryReason: "waiting-on-dependencies" }
            : {}) as never,
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // The dependency finishes after the first poll; the joined run never does here.
        statuses[first] = "completed";
      },
    });

    const firstOnly = await subject.wait({ runIds: [first], timeoutMs: 10_000 });
    expect(firstOnly.finished).toBe(true);
    expect(firstOnly.children.map((child) => child.runId)).toEqual([first]);

    const everything = await subject.wait({ timeoutMs: 1_000 });
    expect(everything.finished).toBe(false);
    expect(everything.children.find((child) => child.runId === joined)).toMatchObject({
      lifecycleStatus: "waiting",
      after: [first],
      reason: "waiting-on-dependencies",
    });
  });
});
