import { describe, expect, it } from "vitest";
import { buildMenuBarItems, formatRedactedHostDiagnostics } from "./menuBar";

describe("macOS menu-bar host controls", () => {
  it("shows non-sensitive host state, activity, and attention without thread content", () => {
    const items = buildMenuBarItems({
      state: "attention-required",
      ownership: "desktop-owned",
      activeAgentCount: 3,
      attentionRequired: true,
    });

    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Host: Attention needed", "Active agents: 3", "Attention needed"]),
    );
    expect(items.map((item) => item.label).join(" ")).not.toMatch(/prompt|thread|secret/i);
  });

  it("disables lifecycle mutations for a separately managed host", () => {
    const items = buildMenuBarItems({
      state: "running",
      ownership: "managed",
      activeAgentCount: 0,
      attentionRequired: false,
    });

    expect(items.find((item) => item.id === "stop-host")).toMatchObject({ enabled: false });
    expect(items.find((item) => item.id === "restart-host")).toMatchObject({ enabled: false });
    expect(items.find((item) => item.id === "open-web")).toMatchObject({ enabled: true });
    expect(items.find((item) => item.id === "start-new-agent")).toMatchObject({ enabled: true });
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
      label: "Fully quit Octant",
      enabled: true,
    });
  });
});
