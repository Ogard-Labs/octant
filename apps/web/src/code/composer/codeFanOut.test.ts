import type { ModelPickerSelection } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { fanOutBranch, startEachModel, toggleFanOutModel } from "./codeFanOut";

const model = (id: string): ModelPickerSelection =>
  ({ providerInstanceId: `provider-${id}`, modelId: `model-${id}` }) as never;

describe("starting one prompt on several models", () => {
  it("adds and removes models beside the chosen one, up to four in all", () => {
    const primary = model("a");
    let extra: ReadonlyArray<ModelPickerSelection> = [];
    extra = toggleFanOutModel(primary, extra, model("b"));
    extra = toggleFanOutModel(primary, extra, model("c"));
    extra = toggleFanOutModel(primary, extra, model("d"));
    expect(extra).toHaveLength(3);
    expect(toggleFanOutModel(primary, extra, model("e"))).toBe(extra);
    expect(toggleFanOutModel(primary, extra, primary)).toBe(extra);
    expect(toggleFanOutModel(primary, extra, model("c")).map((each) => each.modelId)).toEqual([
      "model-b",
      "model-d",
    ]);
  });

  it("names each later thread's branch after its model", () => {
    expect(fanOutBranch("octant/fix-login", model("a"), 0)).toBe("octant/fix-login");
    expect(
      fanOutBranch("octant/fix-login", { ...model("a"), modelId: "GPT 5.1/Codex" } as never, 1),
    ).toBe("octant/fix-login-gpt-5-1-codex");
  });

  it("two selected models start two threads in two new worktrees", async () => {
    const start = vi.fn(async (_selection: ModelPickerSelection | undefined, _branch: string) => ({
      status: "started" as const,
      threadId: "t",
    }));
    const results = await startEachModel([model("a"), model("b")], "octant/fix", start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.map((call) => call[1])).toEqual(["octant/fix", "octant/fix-model-b"]);
    expect(results.map((result) => result.outcome.status)).toEqual(["started", "started"]);
  });

  it("one refused model does not undo the other's start", async () => {
    const start = vi.fn(async (selection: ModelPickerSelection | undefined) =>
      String(selection?.modelId) === "model-a"
        ? { status: "refused" as const, reason: "No sign-in." }
        : { status: "started" as const, threadId: "thread-b" },
    );
    const results = await startEachModel([model("a"), model("b")], "octant/fix", start);
    expect(results.map((result) => result.outcome)).toEqual([
      { status: "refused", reason: "No sign-in." },
      { status: "started", threadId: "thread-b" },
    ]);
  });
});
