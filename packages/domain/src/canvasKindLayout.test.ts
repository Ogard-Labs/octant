import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasSequenceBlock } from "@octant/contracts/canvas";
import { loginSequenceBlock, orderStateBlock } from "./canvasDiagramExamples";
import { layoutCanvasSequence, layoutCanvasState } from "./canvasKindLayout";

const snapshot = JSON.parse(
  readFileSync(new URL("./canvasKindLayout.snapshot.json", import.meta.url), "utf8"),
) as {
  readonly sequence: ReturnType<typeof layoutCanvasSequence>;
  readonly state: ReturnType<typeof layoutCanvasState>;
};

describe("sequence and state diagram layout", () => {
  it("lays a login sequence out the same way every time", () => {
    const layout = layoutCanvasSequence(loginSequenceBlock);

    expect(layout).toEqual(snapshot.sequence);
    expect(layoutCanvasSequence(loginSequenceBlock)).toEqual(layout);
    const [person, browser, auth] = layout.participants;
    expect(person?.x).toBeLessThan(browser?.x ?? 0);
    expect(browser?.x).toBeLessThan(auth?.x ?? 0);
    const [submit, signIn, session] = layout.messages;
    expect(submit?.points[0]?.y).toBeLessThan(signIn?.points[0]?.y ?? 0);
    expect(signIn?.points[0]?.y).toBeLessThan(session?.points[0]?.y ?? 0);
    const note = layout.notes[0];
    expect(note?.x).toBeGreaterThan(auth?.x ?? 0);
  });

  it("bends a message a participant sends to itself out beside its lifeline", () => {
    const block: CanvasSequenceBlock = {
      ...loginSequenceBlock,
      messages: [
        {
          messageId: "retry" as never,
          from: "auth" as never,
          to: "auth" as never,
          label: "Retry",
        },
      ],
      activations: undefined,
      notes: undefined,
    };
    const layout = layoutCanvasSequence(block);
    const message = layout.messages[0];
    const auth = layout.participants.find((participant) => participant.participantId === "auth");

    expect(message?.self).toBe(true);
    expect(message?.points[1]?.x).toBeGreaterThan(auth?.lifelineX ?? 0);
    expect(layoutCanvasSequence(block)).toEqual(layout);
  });

  it("lays an order state machine out the same way every time", () => {
    const layout = layoutCanvasState(orderStateBlock);

    expect(layout).toEqual(snapshot.state);
    expect(layoutCanvasState(orderStateBlock)).toEqual(layout);
    const byId = new Map(layout.states.map((state) => [state.stateId, state]));
    const start = byId.get("start");
    const placed = byId.get("placed");
    const paid = byId.get("paid");
    const authorized = byId.get("authorized");
    const closed = byId.get("closed");
    expect(start?.y).toBeLessThan(placed?.y ?? 0);
    expect(placed?.y).toBeLessThan(paid?.y ?? 0);
    expect(authorized?.x).toBeGreaterThan(paid?.x ?? 0);
    expect((authorized?.y ?? 0) + (authorized?.height ?? 0)).toBeLessThanOrEqual(
      (paid?.y ?? 0) + (paid?.height ?? 0),
    );
    expect(closed?.y).toBeGreaterThan(paid?.y ?? 0);
    expect(byId.get("cancelled")?.role).toBe("final");
    expect(byId.get("start")?.role).toBe("initial");
  });
});
