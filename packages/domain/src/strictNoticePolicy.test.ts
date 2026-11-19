import { describe, expect, it } from "vitest";
import { blockedToolRefusal, mcpServerTool } from "./blockedToolsPolicy";
import { showsStrictNotice, strictKeptAtLaunch, strictKeptSentence } from "./strictNoticePolicy";

describe("what Strict kept for a launch", () => {
  it("names nothing for a launch outside Strict", () => {
    expect(strictKeptAtLaunch({ strict: false, driverKind: "claude", sandboxed: true })).toBe(
      undefined,
    );
  });

  it("names only the protections Strict applies to each runtime", () => {
    expect(strictKeptAtLaunch({ strict: true, driverKind: "claude", sandboxed: true })).toEqual([
      "octant-sandbox",
      "protected-files",
      "fixed-environment",
      "provider-channels-off",
      "octant-project-trust",
      "outside-content-withdrawal",
      "forge-asks",
    ]);
    // OpenCode keeps its own environment and channels under Strict, and has no
    // CLI trust record Octant reads; at Full access without the sandbox there
    // is no Octant sandbox to name.
    expect(strictKeptAtLaunch({ strict: true, driverKind: "opencode", sandboxed: false })).toEqual([
      "protected-files",
      "outside-content-withdrawal",
      "forge-asks",
    ]);
    expect(strictKeptAtLaunch({ strict: true, driverKind: "codex", sandboxed: true })).toEqual([
      "octant-sandbox",
      "protected-files",
      "fixed-environment",
      "octant-project-trust",
      "outside-content-withdrawal",
      "forge-asks",
    ]);
  });

  it("says it once per change rather than on every turn", () => {
    const kept = strictKeptAtLaunch({ strict: true, driverKind: "pi", sandboxed: true });
    const open = strictKeptAtLaunch({ strict: true, driverKind: "pi", sandboxed: false });
    expect(showsStrictNotice(kept, undefined)).toBe(true);
    expect(showsStrictNotice(kept, kept)).toBe(false);
    expect(showsStrictNotice(open, kept)).toBe(true);
    expect(showsStrictNotice(undefined, kept)).toBe(false);
    expect(strictKeptSentence(["octant-sandbox", "protected-files"])).toBe(
      "Strict kept: Octant's sandbox, protected files.",
    );
  });
});

describe("tools a provider can keep blocked", () => {
  it("refuses a Codex built-in its configuration cannot switch off and takes every other provider's names", () => {
    expect(blockedToolRefusal("codex", "shell")).toBe(undefined);
    expect(blockedToolRefusal("codex", "docs__search")).toBe(undefined);
    expect(blockedToolRefusal("codex", "apply_patch")).toMatch(/Codex can block/);
    expect(blockedToolRefusal("claude", "WebFetch")).toBe(undefined);
    expect(mcpServerTool("docs__search")).toEqual({ server: "docs", tool: "search" });
    expect(mcpServerTool("__search")).toBe(undefined);
  });
});
