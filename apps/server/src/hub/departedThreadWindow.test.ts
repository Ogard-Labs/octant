import {
  decodeHostId,
  decodeWindowId,
  decodeWorkspaceTab,
  type MovedThreadReference,
  type WindowWorkspace,
} from "@octant/contracts";
import { defaultWindowWorkspace } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { windowShowsDepartedThread } from "./departedThreadWindow";

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const DEPARTED: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const OTHER_DEPARTED: MovedThreadReference = {
  mode: "code",
  threadId: "88888888-8888-4888-8888-888888888888",
};

function showing(surface: unknown, host?: string): WindowWorkspace {
  const base = defaultWindowWorkspace(windowId);
  const layout = base.layouts.code;
  if (layout.kind !== "pane") throw new Error("expected one pane");
  return {
    ...base,
    contextByMode: {
      ...base.contextByMode,
      code: {
        ...base.contextByMode.code,
        ...(host === undefined ? {} : { host: decodeHostId(host) }),
      },
    },
    layouts: { ...base.layouts, code: { ...layout, surface: decodeWorkspaceTab(surface) } },
  };
}

const tombstonePane = {
  kind: "code-overview",
  id: "99999999-9999-4999-8999-999999999999",
  threadId: DEPARTED.threadId,
  mode: "code",
  title: "Moved thread",
};

describe("the window Remove worktree trusts", () => {
  it("is one that shows that moved thread's own pane on this computer", () => {
    expect(windowShowsDepartedThread(showing(tombstonePane), DEPARTED)).toBe(true);
  });

  it("is not one whose tombstone pane names a different moved thread", () => {
    // Opening one tombstone authorizes Remove worktree for that move alone.
    expect(windowShowsDepartedThread(showing(tombstonePane), OTHER_DEPARTED)).toBe(false);
  });

  it("is not one that reads another host, or shows the thread id under another host or another surface", () => {
    expect(
      windowShowsDepartedThread(
        showing(tombstonePane, "11111111-1111-4111-8111-111111111111"),
        DEPARTED,
      ),
    ).toBe(false);
    expect(
      windowShowsDepartedThread(
        showing({ ...tombstonePane, hostId: "11111111-1111-4111-8111-111111111111" }),
        DEPARTED,
      ),
    ).toBe(false);
    expect(
      windowShowsDepartedThread(
        showing({ ...tombstonePane, kind: "code-terminal", title: "Terminal" }),
        DEPARTED,
      ),
    ).toBe(false);
    expect(windowShowsDepartedThread(showing(tombstonePane), { ...DEPARTED, mode: "chat" })).toBe(
      false,
    );
  });
});
