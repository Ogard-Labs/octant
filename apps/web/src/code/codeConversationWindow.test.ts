import type { CodeThreadId } from "@octant/contracts/code";
import type { CodeOperationId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { CodeConversationMessage } from "./codeControllerState";
import {
  NO_EARLIER_CONVERSATION,
  earlierRowState,
  joinNewestWindow,
  nextEarlierRead,
} from "./codeConversationWindow";

const source = "10000000-0000-4000-8000-000000000077" as CodeThreadId;
const forkPoint = "70000000-0000-4000-8000-000000000009";
const own = (index: number): CodeConversationMessage => ({
  id: `op-${String(index)}:user`,
  role: "user",
  text: `own ${String(index)}`,
  operationId: `op-${String(index)}` as CodeOperationId,
});
const inherited = (index: number): CodeConversationMessage => ({
  ...own(100 + index),
  sourceThreadId: source,
});

describe("Code conversation window", () => {
  it("keeps the inherited turns when a newest window that reaches the thread's start replaces its own", () => {
    const joined = joinNewestWindow([inherited(1), own(1)], [own(2)], false);
    expect(joined.kind).toBe("replaced");
    expect(joined.messages.map((message) => message.text)).toEqual(["own 101", "own 2"]);
  });

  it("lets the inherited turns go when the newest window no longer touches them", () => {
    const joined = joinNewestWindow([inherited(1), own(1)], [own(5), own(6)], true);
    expect(joined.messages.map((message) => message.text)).toEqual(["own 5", "own 6"]);
  });

  it("reads the thread's own earlier turns before a fork's source, then the source at the fork point", () => {
    const fork = { threadId: source, throughOperationId: forkPoint };
    const state = { ...NO_EARLIER_CONVERSATION, threadKey: "fork", ownHasEarlier: true };
    expect(nextEarlierRead(state, [own(3), own(4)], fork)).toEqual({
      kind: "own",
      before: "op-3",
    });
    expect(nextEarlierRead({ ...state, ownHasEarlier: false }, [own(3)], fork)).toEqual({
      kind: "inherited",
      cursor: { threadId: source, anchor: { through: forkPoint }, lineage: ["fork"] },
    });
    expect(
      nextEarlierRead({ ...state, ownHasEarlier: false, inherited: "complete" }, [own(3)], fork),
    ).toEqual({ kind: "none" });
  });

  it("shows no row for a thread that never had earlier messages, and says when the start is reached", () => {
    const state = { ...NO_EARLIER_CONVERSATION, threadKey: "thread" };
    expect(earlierRowState(state, [own(1)], undefined)).toBeUndefined();
    expect(earlierRowState({ ...state, offered: true }, [own(1)], undefined)).toBe("none-left");
    expect(
      earlierRowState({ ...state, ownHasEarlier: true, loading: "loading" }, [own(1)], undefined),
    ).toBe("loading");
  });
});
