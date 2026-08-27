import { describe, expect, it } from "vitest";
import {
  isPluginSidebarDestinationEntryPoint,
  loadPluginSidebarDestinationAction,
} from "./pluginSidebarDestinationRegistry";

describe("plugin sidebar destination registry", () => {
  it("returns the built-in thread-board destination action", () => {
    const action = loadPluginSidebarDestinationAction("builtin:board/destination");
    expect(action).toBeDefined();
  });

  it("returns the built-in pull-requests destination action", () => {
    const action = loadPluginSidebarDestinationAction("builtin:github/sidebar-destination");
    expect(action).toBeDefined();
  });

  it("reports built-in entry points as registered", () => {
    expect(isPluginSidebarDestinationEntryPoint("builtin:board/destination")).toBe(true);
    expect(isPluginSidebarDestinationEntryPoint("builtin:github/sidebar-destination")).toBe(true);
  });

  it("returns undefined for unknown entry points", () => {
    expect(loadPluginSidebarDestinationAction("unknown:plugin/destination")).toBeUndefined();
    expect(isPluginSidebarDestinationEntryPoint("unknown:plugin/destination")).toBe(false);
  });
});
