import { describe, expect, it, vi } from "vitest";
import {
  isPluginSidebarDestinationEntryPoint,
  loadPluginSidebarDestinationAction,
} from "./pluginSidebarDestinationRegistry";

describe("plugin sidebar destination registry", () => {
  it("returns the built-in thread-board destination action", () => {
    const result = loadPluginSidebarDestinationAction("builtin:board/destination");
    expect(result.kind).toBe("ready");
  });

  it("returns the built-in pull-requests destination action", () => {
    const result = loadPluginSidebarDestinationAction("builtin:github/sidebar-destination");
    expect(result.kind).toBe("ready");
  });

  it("returns the built-in GitHub issues destination action", () => {
    const result = loadPluginSidebarDestinationAction("builtin:github/issues-destination");
    expect(result.kind).toBe("ready");
  });

  it("returns the Linear issues destination action", () => {
    const result = loadPluginSidebarDestinationAction("builtin:linear/sidebar-destination");
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const openLinearIssues = vi.fn();
    result.action({
      closeOverlays: vi.fn(),
      openThreadBoard: vi.fn(),
      openPullRequests: vi.fn(),
      openGithubIssues: vi.fn(),
      openLinearIssues,
    });
    expect(openLinearIssues).toHaveBeenCalledOnce();
  });

  it("reports built-in entry points as registered", () => {
    expect(isPluginSidebarDestinationEntryPoint("builtin:board/destination")).toBe(true);
    expect(isPluginSidebarDestinationEntryPoint("builtin:github/sidebar-destination")).toBe(true);
    expect(isPluginSidebarDestinationEntryPoint("builtin:github/issues-destination")).toBe(true);
    expect(isPluginSidebarDestinationEntryPoint("builtin:linear/sidebar-destination")).toBe(true);
  });

  it("returns an unknown result for unknown entry points", () => {
    expect(loadPluginSidebarDestinationAction("unknown:plugin/destination")).toEqual({
      kind: "unknown",
      entryPoint: "unknown:plugin/destination",
    });
    expect(isPluginSidebarDestinationEntryPoint("unknown:plugin/destination")).toBe(false);
  });

  it("does not resolve inherited Object.prototype names", () => {
    expect(isPluginSidebarDestinationEntryPoint("constructor")).toBe(false);
    expect(isPluginSidebarDestinationEntryPoint("toString")).toBe(false);
    expect(loadPluginSidebarDestinationAction("constructor").kind).toBe("unknown");
    expect(loadPluginSidebarDestinationAction("toString").kind).toBe("unknown");
  });
});
