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

function port(posture: "off" | "ask" | "automatic", admitted: unknown[] = []) {
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
      persistence: {
        parentSummary: () => [],
        resultText: () => undefined,
        getById: () => undefined,
      },
      router: { resolve: () => ({ kind: "unroutable" }) as never },
      sessions: { ensure: () => ({}) as never, recordRouteDecision: () => undefined },
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

  it("tells the model a person must confirm under the Ask posture", async () => {
    const outcome = await port("ask").start({
      role: "research",
      task: "Look",
      includeParentContext: false,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "creation-posture-ask" });
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
});
