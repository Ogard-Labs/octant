import { describe, expect, it, vi } from "vitest";
import type { OneShotOutcome } from "./nativeHarnessSingleShot";
import { createNativeHarnessSecondOpinionPort } from "./nativeHarnessSecondOpinion";

const hostId = "00000000-0000-4000-8000-0000000000aa";
const primary = {
  hostId,
  providerInstanceId: "00000000-0000-4000-8000-0000000000e3",
  modelId: "advisor-primary",
};
const backup = {
  hostId,
  providerInstanceId: "00000000-0000-4000-8000-0000000000e4",
  modelId: "advisor-backup",
};
const scope = {
  threadId: "00000000-0000-4000-8000-000000000031",
  mode: "work" as const,
  lead: {
    hostId,
    providerInstanceId: "00000000-0000-4000-8000-0000000000e1",
    modelId: "lead-model",
  },
} as never;

const selected = (candidate: typeof primary) => ({ kind: "primary", slotId: "advisor", candidate });
const unroutable = { kind: "unroutable", slotId: "advisor", reason: "slot-empty" };

const fixture = (input: {
  /** What the router resolves to now, given the failures reported so far. */
  readonly route: (failed: number) => unknown;
  readonly outcomes: ReadonlyArray<OneShotOutcome>;
  readonly driver?: boolean;
}) => {
  let failed = 0;
  let next = 0;
  const journal: unknown[] = [];
  const reportFailure = vi.fn(() => {
    failed += 1;
  });
  const complete = vi.fn(
    async (_request: unknown): Promise<OneShotOutcome> =>
      input.outcomes[next++] ?? { status: "unreached" },
  );
  const ask = createNativeHarnessSecondOpinionPort(
    {
      router: { resolve: () => input.route(failed) as never, reportFailure },
      sessions: {
        ensure: vi.fn(() => ({}) as never),
        recordRouteDecision: (_threadId: string, decision: unknown) => {
          journal.push(decision);
        },
      },
      resolveDriver: () => (input.driver === false ? undefined : ({} as never)),
      scratchRoot: "/scratch",
      uuid: () => "00000000-0000-4000-8000-000000000042",
      complete: complete as never,
    },
    scope,
  );
  return { ask, complete, journal, reportFailure };
};

describe("second opinion", () => {
  it("sends only the question to the advisor slot's model, journals the route, and returns its advice", async () => {
    const { ask, complete, journal } = fixture({
      route: () => selected(primary),
      outcomes: [{ status: "completed", text: "  Split the change.  " }],
    });
    expect(await ask({ question: "Should I split this diff?" })).toBe("Split the change.");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Should I split this diff?",
        projectRoot: "/scratch",
        modelId: "advisor-primary",
      }),
    );
    expect(journal).toEqual([expect.objectContaining({ kind: "primary", candidate: primary })]);
  });

  it("journals a refusal when no advisor model is chosen", async () => {
    const { ask, complete, journal } = fixture({ route: () => unroutable, outcomes: [] });
    expect(await ask({ question: "Is this safe?" })).toBeUndefined();
    expect(journal).toEqual([
      expect.objectContaining({ kind: "unroutable", reason: "slot-empty" }),
    ]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("puts a failed advisor on cooldown and asks the slot's backup", async () => {
    const { ask, complete, journal, reportFailure } = fixture({
      route: (failed) => selected(failed === 0 ? primary : backup),
      outcomes: [
        { status: "failed", failure: { category: "rate-limited", message: "slow down" } as never },
        { status: "completed", text: "Ship it." },
      ],
    });
    expect(await ask({ question: "Ready?" })).toBe("Ship it.");
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        slotId: "advisor",
        candidate: primary,
        reason: "rate-limited",
      }),
    );
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: "advisor-backup" }),
    );
    expect(journal).toHaveLength(2);
  });

  it("reports a timed-out advisor and gives up when no other model is left", async () => {
    const { ask, reportFailure } = fixture({
      route: () => selected(primary),
      outcomes: [{ status: "timed-out" }],
    });
    expect(await ask({ question: "Ready?" })).toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }));
  });

  it.each([
    ["its driver cannot be built", { driver: false, outcomes: [] }],
    ["the advisor gave no usable reply", { outcomes: [{ status: "completed", text: "   " }] }],
    ["the advisor read outside content", { outcomes: [{ status: "withheld" }] }],
  ] as const)("answers nothing without blaming the model when %s", async (_label, input) => {
    const { ask, reportFailure } = fixture({ route: () => selected(primary), ...input } as never);
    expect(await ask({ question: "Is this safe?" })).toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("stops waiting when the turn is cancelled and does not blame the model", async () => {
    const abort = new AbortController();
    const reportFailure = vi.fn();
    const hung = createNativeHarnessSecondOpinionPort(
      {
        router: { resolve: () => selected(primary) as never, reportFailure },
        sessions: { ensure: () => ({}) as never, recordRouteDecision: () => undefined },
        resolveDriver: () => ({}) as never,
        scratchRoot: "/scratch",
        uuid: () => "00000000-0000-4000-8000-000000000042",
        complete: (() => new Promise(() => undefined)) as never,
      },
      scope,
    );
    const pending = hung({ question: "Still there?", signal: abort.signal });
    abort.abort();
    expect(await pending).toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });
});
