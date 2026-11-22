import { describe, expect, it } from "vitest";
import {
  MEMBER_LOAD_HOLD_MS,
  holdMemberLoad,
  observedMemberLoad,
  type MemberLoadState,
} from "./memberLoadPolicy";

describe("a member's load level", () => {
  it("reads busy from elevated memory or two turns, and heavy from critical memory or five", () => {
    expect(observedMemberLoad({ memoryPressure: "normal", liveTurns: 1 })).toBe("light");
    expect(observedMemberLoad({ memoryPressure: "normal", liveTurns: 2 })).toBe("busy");
    expect(observedMemberLoad({ memoryPressure: "elevated", liveTurns: 0 })).toBe("busy");
    expect(observedMemberLoad({ memoryPressure: "normal", liveTurns: 5 })).toBe("heavy");
    expect(observedMemberLoad({ memoryPressure: "critical", liveTurns: 0 })).toBe("heavy");
  });

  it("reports a new level only after it has held, and forgets a burst that passes", () => {
    let state: MemberLoadState = { reported: "light" };
    state = holdMemberLoad(state, "heavy", 0);
    expect(state.reported).toBe("light");
    state = holdMemberLoad(state, "heavy", MEMBER_LOAD_HOLD_MS - 1);
    expect(state.reported).toBe("light");
    state = holdMemberLoad(state, "heavy", MEMBER_LOAD_HOLD_MS);
    expect(state).toEqual({ reported: "heavy" });

    // A burst that ends before it holds changes nothing.
    state = holdMemberLoad(state, "light", MEMBER_LOAD_HOLD_MS + 1);
    state = holdMemberLoad(state, "heavy", MEMBER_LOAD_HOLD_MS + 2);
    expect(state).toEqual({ reported: "heavy" });
    // A different reading restarts the wait.
    state = holdMemberLoad(state, "busy", 1_000_000);
    state = holdMemberLoad(state, "light", 1_000_000 + MEMBER_LOAD_HOLD_MS);
    expect(state.reported).toBe("heavy");
    expect(state.pending).toEqual({ level: "light", since: 1_000_000 + MEMBER_LOAD_HOLD_MS });
  });
});
