import { describe, expect, it } from "vitest";
import { stepRemoveHostFlow } from "./removeHostFlow";

describe("remove host confirmation", () => {
  it("removes only after the person asks and then confirms", () => {
    const asked = stepRemoveHostFlow("idle", "ask");
    expect(asked).toEqual({ state: "confirming", remove: false });
    expect(stepRemoveHostFlow(asked.state, "confirm")).toEqual({ state: "idle", remove: true });
  });

  it("removes nothing when the person cancels", () => {
    const asked = stepRemoveHostFlow("idle", "ask");
    expect(stepRemoveHostFlow(asked.state, "cancel")).toEqual({ state: "idle", remove: false });
  });

  it("does not remove on a confirm that was never asked for", () => {
    expect(stepRemoveHostFlow("idle", "confirm")).toEqual({ state: "idle", remove: false });
  });
});
