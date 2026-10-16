import { describe, expect, it, vi } from "vitest";
import { createNativeHarnessSecondOpinionPort } from "./nativeHarnessSecondOpinion";

const candidate = {
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-0000000000e3",
  modelId: "advisor-model",
};

const port = (input: {
  readonly routable: boolean;
  readonly driver?: boolean;
  readonly reply?: string | undefined;
}) => {
  const complete = vi.fn(async () => input.reply);
  const resolve = vi.fn(() =>
    input.routable
      ? ({ kind: "selected", candidate } as never)
      : ({ kind: "unroutable", reason: "slot-empty" } as never),
  );
  return {
    complete,
    resolve,
    ask: createNativeHarnessSecondOpinionPort(
      {
        router: { resolve },
        resolveDriver: () => (input.driver === false ? undefined : ({} as never)),
        scratchRoot: "/scratch",
        uuid: () => "00000000-0000-4000-8000-000000000042",
        complete: complete as never,
      },
      { projectId: undefined },
    ),
  };
};

describe("second opinion", () => {
  it("sends only the question to the advisor slot's model and returns its advice", async () => {
    const { ask, complete, resolve } = port({ routable: true, reply: "  Split the change.  " });
    expect(await ask({ question: "Should I split this diff?" })).toBe("Split the change.");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ job: "advisor" }));
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Should I split this diff?",
        projectRoot: "/scratch",
        modelId: "advisor-model",
      }),
    );
  });

  it.each([
    ["no advisor model is chosen", { routable: false }],
    ["its driver cannot be built", { routable: true, driver: false }],
    ["the advisor gave no usable reply", { routable: true, reply: "   " }],
  ])("answers nothing when %s", async (_label, input) => {
    expect(await port(input).ask({ question: "Is this safe?" })).toBeUndefined();
  });

  it("stops waiting when the turn is cancelled", async () => {
    const abort = new AbortController();
    const hung = createNativeHarnessSecondOpinionPort(
      {
        router: { resolve: () => ({ kind: "selected", candidate }) as never },
        resolveDriver: () => ({}) as never,
        scratchRoot: "/scratch",
        uuid: () => "00000000-0000-4000-8000-000000000042",
        complete: (() => new Promise(() => undefined)) as never,
      },
      {},
    );
    const pending = hung({ question: "Still there?", signal: abort.signal });
    abort.abort();
    expect(await pending).toBeUndefined();
  });
});
