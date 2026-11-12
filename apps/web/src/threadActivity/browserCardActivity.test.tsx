import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentBrowserCardContext,
  dismissBrowserCard,
  dismissLiveBrowserCard,
  reportBrowserActivity,
  resetBrowserCardActivityForTests,
  useAgentBrowserCard,
} from "./browserCardActivity";

const session = "30000000-0000-4000-8000-000000000001";

afterEach(resetBrowserCardActivityForTests);

describe("the agent's Browser card", () => {
  it("is wanted while the session is live and the Browser is out of sight", () => {
    reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    expect(agentBrowserCardContext("thread-a")).toBe(session);
    expect(agentBrowserCardContext("thread-b")).toBeUndefined();
    expect(agentBrowserCardContext(undefined)).toBeUndefined();
  });

  it("is not wanted without a live session, or while the Browser is in sight", () => {
    reportBrowserActivity("thread-a", { contextId: undefined, inSight: false });
    expect(agentBrowserCardContext("thread-a")).toBeUndefined();
    reportBrowserActivity("thread-b", { contextId: session, inSight: true });
    expect(agentBrowserCardContext("thread-b")).toBeUndefined();
  });

  it("is dismissed for the session once closed, and a new session brings it back", () => {
    const first = reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    dismissBrowserCard("thread-a", session);
    expect(agentBrowserCardContext("thread-a")).toBeUndefined();
    // The pane withdraws its report before it makes the next one.
    first();
    const next = "30000000-0000-4000-8000-000000000002";
    reportBrowserActivity("thread-a", { contextId: next, inSight: false });
    expect(agentBrowserCardContext("thread-a")).toBe(next);
  });

  it("stays dismissed after the pane that reported it remounts", () => {
    const withdraw = reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    dismissLiveBrowserCard("thread-a");
    withdraw();
    reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    expect(agentBrowserCardContext("thread-a")).toBeUndefined();
  });

  it("is withdrawn with the pane that reported it, and another pane's report stands", () => {
    const first = reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    const second = reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    first();
    expect(agentBrowserCardContext("thread-a")).toBe(session);
    second();
    expect(agentBrowserCardContext("thread-a")).toBeUndefined();
  });

  it("tells a reader when it appears and when it goes", () => {
    const { result } = renderHook(() => useAgentBrowserCard("thread-a"));
    expect(result.current).toBeUndefined();
    let withdraw: () => void = () => undefined;
    act(() => {
      withdraw = reportBrowserActivity("thread-a", { contextId: session, inSight: false });
    });
    expect(result.current).toBe(session);
    act(() => withdraw());
    expect(result.current).toBeUndefined();
  });
});
