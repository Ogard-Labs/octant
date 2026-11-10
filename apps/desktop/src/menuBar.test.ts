import { describe, expect, it } from "vitest";
import type { FleetActivity, FleetActivityThread } from "@octant/contracts/fleet-activity";
import {
  buildMenuBarItems,
  decodeMenuBarOpenThread,
  decodeMenuBarShutdownProgress,
  formatRedactedHostDiagnostics,
  MenuBarFleet,
  menuBarTitle,
} from "./menuBar";

function working(
  threadId: string,
  title: string,
  mode: FleetActivityThread["mode"] = "code",
): FleetActivityThread {
  return {
    mode,
    threadId,
    title,
    projectName: "Reports",
    state: "working",
    activitySource: "journal",
  };
}

function needsYou(threadId: string, title: string): FleetActivityThread {
  return {
    mode: "work",
    threadId,
    title,
    projectName: "Reports",
    state: "needs-you",
    activitySource: "session",
  };
}

function activity(threads: ReadonlyArray<FleetActivityThread>): FleetActivity {
  return { threads, truncated: false };
}

describe("macOS menu-bar host controls", () => {
  it("keeps everyday actions above host controls and hides empty activity", () => {
    const items = buildMenuBarItems({
      state: "running",
      ownership: "desktop-owned",
      activeAgentCount: 0,
      attentionRequired: false,
    });
    expect(items.map((item) => item.label).filter(Boolean)).toEqual([
      "Open Octant",
      "New task…",
      "Local host",
      "Quit Octant",
    ]);
    expect(
      items
        .find((item) => item.id === "local-host")
        ?.submenu?.map((item) => item.label)
        .filter(Boolean),
    ).toEqual([
      "Status: Running",
      "Open local web app",
      "Stop local host",
      "Restart local host",
      "Open redacted diagnostics",
    ]);
  });

  it("disables lifecycle mutations for a separately managed host", () => {
    const root = buildMenuBarItems({
      state: "running",
      ownership: "managed",
      activeAgentCount: 0,
      attentionRequired: false,
    });

    const items = [...root, ...(root.find((item) => item.id === "local-host")?.submenu ?? [])];
    expect(items.find((item) => item.id === "stop-host")).toMatchObject({ enabled: false });
    expect(items.find((item) => item.id === "restart-host")).toMatchObject({ enabled: false });
    expect(items.find((item) => item.id === "open-web")).toMatchObject({ enabled: true });
    expect(items.find((item) => item.id === "start-new-agent")).toMatchObject({ enabled: true });
  });

  it("groups the fleet as needs you, working, and done since you looked, and keeps stopped hosts free of stale rows", () => {
    const snapshot = {
      state: "running" as const,
      ownership: "desktop-owned" as const,
      activeAgentCount: 1,
      attentionRequired: false,
    };
    const fleet = new MenuBarFleet();
    fleet.observe(activity([working("a", "Fix startup"), needsYou("b", "Review plan")]));
    fleet.observe(activity([needsYou("b", "Review plan"), working("c", "Draft notes", "work")]));
    const items = buildMenuBarItems(snapshot, fleet.threads());
    expect(items.map((item) => item.label).filter(Boolean)).toEqual([
      "Open Octant",
      "New task…",
      "Needs you · 1",
      "Review plan — Work · Reports",
      "Working · 1",
      "Draft notes — Work · Reports",
      "Done since you looked · 1",
      "Fix startup — Code · Reports",
      "Local host",
      "Quit Octant",
    ]);
    expect(items.find((item) => item.label.startsWith("Fix startup"))).toMatchObject({
      thread: { mode: "code", threadId: "a", state: "done", activitySource: "journal" },
      toolTip: "Finished since you last opened it · read from the journal",
    });
    expect(items.find((item) => item.label.startsWith("Review plan"))?.toolTip).toBe(
      "Waiting on you · read from the live session",
    );
    expect(
      buildMenuBarItems({ ...snapshot, state: "stopped" }, fleet.threads()).some(
        (item) => item.thread !== undefined,
      ),
    ).toBe(false);
    const host = buildMenuBarItems({ ...snapshot, state: "stopped" }).find(
      (item) => item.id === "local-host",
    );
    expect(host?.submenu?.filter((item) => item.enabled).map((item) => item.label)).toEqual([
      "Start local host",
      "Open redacted diagnostics",
    ]);
  });

  it("clears a done row once the thread is opened, and again when it runs anew", () => {
    const fleet = new MenuBarFleet();
    fleet.observe(activity([working("a", "Fix startup"), working("b", "Ship")]));
    fleet.observe(activity([]));
    expect(fleet.threads().map((thread) => [thread.threadId, thread.state])).toEqual([
      ["a", "done"],
      ["b", "done"],
    ]);
    fleet.looked({ mode: "code", threadId: "a" });
    expect(fleet.threads().map((thread) => thread.threadId)).toEqual(["b"]);
    fleet.observe(activity([working("b", "Ship")]));
    expect(fleet.threads()).toMatchObject([{ threadId: "b", state: "working" }]);
  });

  it("never reports done for a thread the person is watching", () => {
    const fleet = new MenuBarFleet();
    fleet.observe(activity([working("a", "Fix startup")]));
    fleet.observe(activity([]), [{ mode: "code", threadId: "a" }]);
    expect(fleet.threads()).toEqual([]);
  });

  it("labels a terminal-only observation, never turns it into done, and leaves it out of the count", () => {
    const fleet = new MenuBarFleet();
    const seen = { ...working("t", "claude in a pane"), activitySource: "screen" as const };
    fleet.observe(activity([seen, needsYou("b", "Review plan")]));
    const snapshot = {
      state: "running" as const,
      ownership: "desktop-owned" as const,
      activeAgentCount: 0,
      attentionRequired: false,
    };
    const row = buildMenuBarItems(snapshot, fleet.threads()).find(
      (item) => item.thread?.threadId === "t",
    );
    expect(row).toMatchObject({
      label: "claude in a pane — Code · Reports · seen in terminal",
      toolTip: "Looks busy in a terminal pane · Octant does not notify for it",
    });
    expect(menuBarTitle(snapshot, fleet.threads())).toBe("1");
    fleet.observe(activity([]));
    expect(fleet.threads().map((thread) => thread.threadId)).toEqual(["b"]);
  });

  it("infers nothing from a read that was cut or that failed", () => {
    const fleet = new MenuBarFleet();
    fleet.observe(activity([working("a", "Fix startup")]));
    fleet.observe({ threads: [], truncated: true });
    expect(fleet.threads()).toMatchObject([{ threadId: "a", state: "working" }]);
    fleet.clear();
    expect(fleet.threads()).toEqual([]);
  });

  it("shows the host's own trouble before the needs-you count in the menu-bar title", () => {
    const snapshot = {
      state: "running" as const,
      ownership: "desktop-owned" as const,
      activeAgentCount: 0,
      attentionRequired: false,
    };
    const fleet = new MenuBarFleet();
    expect(menuBarTitle(snapshot, fleet.threads())).toBe("");
    fleet.observe(activity([needsYou("a", "One"), needsYou("b", "Two"), working("c", "Three")]));
    expect(menuBarTitle(snapshot, fleet.threads())).toBe("2");
    expect(menuBarTitle({ ...snapshot, attentionRequired: true }, fleet.threads())).toBe("!");
  });

  it("offers Prepare to Shut Down… in a hub and shows a running batch's progress beside the glyph", () => {
    const snapshot = {
      state: "running" as const,
      ownership: "desktop-owned" as const,
      activeAgentCount: 0,
      attentionRequired: false,
    };
    const labels = (shutdown: Parameters<typeof buildMenuBarItems>[2]) =>
      buildMenuBarItems(snapshot, [], shutdown)
        .map((item) => item.label)
        .filter(Boolean);

    // Outside a hub there is nowhere to move to, so the menu bar stays as it was.
    expect(labels({ offered: false })).not.toContain("Prepare to Shut Down…");
    expect(labels({ offered: true })).toEqual([
      "Open Octant",
      "New task…",
      "Prepare to Shut Down…",
      "Local host",
      "Quit Octant",
    ]);
    expect(labels({ offered: true, progress: { ended: 3, total: 9 } })).toEqual([
      "Open Octant",
      "New task…",
      "Moving threads · 3 of 9",
      "Prepare to Shut Down…",
      "Local host",
      "Quit Octant",
    ]);
    expect(menuBarTitle(snapshot, [], { ended: 3, total: 9 })).toBe("3/9");
    // The host needing attention still comes first.
    expect(menuBarTitle({ ...snapshot, attentionRequired: true }, [], { ended: 3, total: 9 })).toBe(
      "!",
    );
  });

  it("accepts only a well-formed batch progress report from a window", () => {
    expect(decodeMenuBarShutdownProgress(null)).toBeUndefined();
    expect(decodeMenuBarShutdownProgress({ ended: 2, total: 5 })).toEqual({ ended: 2, total: 5 });
    expect(() => decodeMenuBarShutdownProgress({ ended: 6, total: 5 })).toThrow();
    expect(() => decodeMenuBarShutdownProgress({ ended: 1.5, total: 5 })).toThrow();
    expect(() => decodeMenuBarShutdownProgress({ ended: 1, total: 5, label: "x" })).toThrow();
  });

  it("accepts only a well-formed open-thread report from a window", () => {
    expect(decodeMenuBarOpenThread(null)).toBeUndefined();
    expect(decodeMenuBarOpenThread({ mode: "work", threadId: "a" })).toEqual({
      mode: "work",
      threadId: "a",
    });
    expect(() => decodeMenuBarOpenThread({ mode: "shell", threadId: "a" })).toThrow();
    expect(() => decodeMenuBarOpenThread({ mode: "code", threadId: "" })).toThrow();
    expect(() => decodeMenuBarOpenThread({ mode: "code", threadId: "a", extra: 1 })).toThrow();
  });

  it("emits bounded redacted diagnostics", () => {
    const diagnostics = formatRedactedHostDiagnostics({
      state: "running",
      ownership: "desktop-owned",
      url: "http://127.0.0.1:13773/private-token",
      activeAgentCount: 2,
      attentionRequired: false,
    });

    expect(diagnostics).toContain("desktop-owned");
    expect(diagnostics).toContain("Active agents: 2");
    expect(diagnostics).not.toContain("private-token");
    expect(diagnostics).not.toMatch(/prompt|thread|credential|secret/i);
  });

  it("says why the host needs a look, in the status line and the diagnostics", () => {
    const needsSetup = {
      state: "attention-required",
      ownership: "desktop-owned",
      activeAgentCount: 0,
      attentionRequired: true,
      attentionReason: "provider-not-ready",
    } as const;
    const status = (snapshot: Parameters<typeof buildMenuBarItems>[0]) =>
      buildMenuBarItems(snapshot)
        .find((item) => item.id === "local-host")
        ?.submenu?.find((item) => item.id === "status")?.label;

    expect(status(needsSetup)).toBe("Status: A provider needs setup (Settings › Providers)");
    expect(formatRedactedHostDiagnostics(needsSetup)).toContain(
      "Attention needed: A provider needs setup (Settings › Providers)",
    );
    expect(status({ ...needsSetup, attentionReason: "provider-stopped" })).toBe(
      "Status: A provider stopped during a task",
    );
    expect(
      status({
        state: "attention-required",
        ownership: "desktop-owned",
        activeAgentCount: 0,
        attentionRequired: true,
        activityUnconfirmed: true,
      }),
    ).toBe("Status: The host did not answer");
  });

  it("always offers an explicit full application shutdown", () => {
    const items = buildMenuBarItems({
      state: "running",
      ownership: "desktop-owned",
      activeAgentCount: 1,
      attentionRequired: false,
    });

    expect(items.at(-1)).toEqual({
      id: "fully-quit",
      label: "Quit Octant",
      enabled: true,
    });
  });
});
