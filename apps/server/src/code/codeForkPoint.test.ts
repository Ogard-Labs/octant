import type { CodeConversationTurn } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { chooseCodeForkPoint } from "./codeForkPoint";

const checkpoint = (n: string) => ({
  worktree: n.repeat(40),
  index: n.repeat(40),
  head: n.repeat(40),
});

/** Only the fields a fork point reads; the rest of a turn does not decide it. */
function turn(
  operationId: string,
  facts: Partial<Pick<CodeConversationTurn, "status" | "checkpoint" | "executionPolicy">> = {},
): CodeConversationTurn {
  return { operationId, status: "completed", ...facts } as never;
}

describe("choosing where a Code fork starts", () => {
  it("starts from what the next turn found before it touched anything", () => {
    expect(
      chooseCodeForkPoint(
        [turn("a", { checkpoint: checkpoint("1") }), turn("b", { checkpoint: checkpoint("2") })],
        "a",
      ),
    ).toEqual({ kind: "checkpoint", checkpoint: checkpoint("2") });
  });

  it("looks past a Plan turn, which writes nothing, to the next recorded state", () => {
    expect(
      chooseCodeForkPoint(
        [
          turn("a"),
          turn("b", { executionPolicy: "plan" }),
          turn("c", { checkpoint: checkpoint("3") }),
        ],
        "a",
      ),
    ).toEqual({ kind: "checkpoint", checkpoint: checkpoint("3") });
  });

  it("refuses rather than guess when a writing turn after the point recorded nothing", () => {
    expect(
      chooseCodeForkPoint(
        [
          turn("a"),
          turn("b", { executionPolicy: "approval-gated" }),
          turn("c", { checkpoint: checkpoint("3") }),
        ],
        "a",
      ),
    ).toEqual({ kind: "refused", reason: "unrecorded" });
  });

  it("captures the checkout as it stands when the chosen turn is the newest", () => {
    expect(chooseCodeForkPoint([turn("a"), turn("b")], "b")).toEqual({ kind: "capture-now" });
  });

  it("refuses a turn that has not finished or is not in the thread", () => {
    expect(chooseCodeForkPoint([turn("a", { status: "incomplete" })], "a")).toEqual({
      kind: "refused",
      reason: "not-settled",
    });
    expect(chooseCodeForkPoint([turn("a")], "z")).toEqual({ kind: "refused", reason: "not-found" });
  });
});
