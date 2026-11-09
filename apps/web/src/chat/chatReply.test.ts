import { describe, expect, it } from "vitest";
import type { ChatThreadView } from "@octant/contracts";
import { turnReplyText } from "./chatReply";

function content(id: string, body: string) {
  return { contentId: id, role: "assistant", body, digest: `d-${id}` };
}
const ref = (id: string) => ({ contentId: id, digest: `d-${id}` });

function view(attempts: ReadonlyArray<{ outcome: string; refs: ReadonlyArray<string> }>) {
  const ids = attempts.flatMap((attempt) => attempt.refs);
  return {
    turns: [
      {
        id: "turn-1",
        attempts: attempts.map((attempt) => ({
          outcome: attempt.outcome,
          responseRefs: attempt.refs.map(ref),
        })),
      },
    ],
    contents: ids.map((id) => content(id, `text of ${id}`)),
  } as unknown as ChatThreadView;
}

describe("the reply text of a turn", () => {
  it("is the answering attempt's reply only, not every completed attempt's", () => {
    const text = turnReplyText(
      view([
        { outcome: "completed", refs: ["first"] },
        { outcome: "completed", refs: ["second"] },
      ]),
      "turn-1",
    );
    expect(text).toBe("text of second");
  });

  it("strips a citation marker split across streamed deltas", () => {
    const split = {
      turns: [
        {
          id: "turn-1",
          attempts: [{ outcome: "completed", responseRefs: [ref("a"), ref("b")] }],
        },
      ],
      contents: [content("a", "Claim.citeturn"), content("b", "9view0 Next sentence.")],
    } as unknown as ChatThreadView;
    expect(turnReplyText(split, "turn-1")).toBe("Claim. Next sentence.");
  });

  it("is absent when no attempt completed", () => {
    expect(turnReplyText(view([{ outcome: "failed", refs: ["x"] }]), "turn-1")).toBeUndefined();
  });
});
