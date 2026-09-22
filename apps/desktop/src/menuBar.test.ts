import { describe, expect, it } from "vitest";
import { buildMenuBarItems, formatRedactedHostDiagnostics } from "./menuBar";

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

  it("groups resumable tasks and keeps stopped hosts free of stale tasks", () => {
    const snapshot = {
      state: "running" as const,
      ownership: "desktop-owned" as const,
      activeAgentCount: 1,
      attentionRequired: true,
    };
    const tasks = [
      {
        threadId: "a",
        mode: "code" as const,
        title: "Fix startup",
        activity: "working" as const,
        windowId: 1,
      },
      {
        threadId: "b",
        mode: "work" as const,
        title: "Review plan",
        activity: "attention" as const,
        windowId: 1,
      },
    ];
    const items = buildMenuBarItems(snapshot, tasks);
    expect(items.map((item) => item.label).filter(Boolean)).toEqual([
      "Open Octant",
      "New task…",
      "Needs attention · 1",
      "Review plan",
      "Running · 1",
      "Fix startup",
      "Local host",
      "Quit Octant",
    ]);
    expect(items.find((item) => item.label === "Fix startup")?.task).toEqual(tasks[0]);
    expect(
      buildMenuBarItems({ ...snapshot, state: "stopped" }, tasks).some((item) => item.task),
    ).toBe(false);
    const host = buildMenuBarItems({ ...snapshot, state: "stopped" }).find(
      (item) => item.id === "local-host",
    );
    expect(host?.submenu?.filter((item) => item.enabled).map((item) => item.label)).toEqual([
      "Start local host",
      "Open redacted diagnostics",
    ]);
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
