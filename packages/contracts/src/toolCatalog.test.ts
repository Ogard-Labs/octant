import { describe, expect, it } from "vitest";
import {
  decodeToolActionCapability,
  listClosedToolCatalog,
  lookupClosedToolCatalogEntry,
  type ToolApprovalClass,
} from "./index";

describe("closed tool catalog", () => {
  it("indexes existing contract capability ids as a closed Octant-owned set", () => {
    const ids = listClosedToolCatalog()
      .map((entry) => entry.name)
      .sort();
    expect(ids).toEqual([
      "browser-automation",
      "computer-use",
      "harness-ask-user",
      "harness-bash",
      "harness-context-remaining",
      "harness-delegate",
      "harness-edit",
      "harness-glob",
      "harness-goal",
      "harness-goal-check",
      "harness-grep",
      "harness-read",
      "harness-second-opinion",
      "harness-todo-write",
      "harness-web-fetch",
      "harness-web-search",
      "harness-write",
      "mcp-tool",
      "repository-validation",
    ]);
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "browser-automation", version: 1 }),
      )?.owner,
    ).toBe("core");
    expect(
      lookupClosedToolCatalogEntry(decodeToolActionCapability({ id: "mcp-tool", version: 1 }))
        ?.owner,
    ).toBe("extension-namespaced");
    expect(
      lookupClosedToolCatalogEntry(
        decodeToolActionCapability({ id: "model-invented-shell", version: 1 }),
      ),
    ).toBeUndefined();
  });

  it("rejects excess properties on catalog argument schemas", () => {
    const browser = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "browser-automation", version: 1 }),
    );
    expect(browser).toBeDefined();
    expect(() =>
      browser!.decodeArguments({
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
        extra: true,
      }),
    ).toThrow();
  });

  it("asks afresh on a marked thread for every tool in an irreversible or authority-bearing class", () => {
    // The thread-elevation step forces a fresh confirmation per catalog entry,
    // not per class, so an entry added to one of these classes without the
    // flag would let Full access cover it on a marked thread.
    const authorityBearing = new Set<ToolApprovalClass>([
      "destructive-irreversible",
      "credential-secret-access",
      "access-outside-project",
      "privilege-expansion",
    ]);
    const escaping = listClosedToolCatalog()
      .filter((entry) => authorityBearing.has(entry.approvalClass))
      .filter((entry) => !entry.irreversibleUnderTaint)
      .map((entry) => entry.name);
    expect(escaping).toEqual([]);
  });
});

describe("native harness catalog entries", () => {
  it("keeps the shell out of Chat and Work, and every read available in Work and Code", () => {
    const bash = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-bash", version: 1 }),
    );
    expect(bash?.modes).toEqual(["code"]);
    expect(bash?.approvalClass).toBe("shell-commands");
    expect(bash?.irreversibleUnderTaint).toBe(true);
    const read = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-read", version: 1 }),
    );
    expect(read?.modes).toEqual(["work", "code"]);
    expect(read?.approvalClass).toBe("project-file-reads");
  });

  it("refuses a harness tool call whose arguments do not match the tool", () => {
    const edit = lookupClosedToolCatalogEntry(
      decodeToolActionCapability({ id: "harness-edit", version: 1 }),
    );
    expect(() => edit!.decodeArguments({ path: "a.ts", oldText: "", newText: "x" })).toThrow();
    expect(() =>
      edit!.decodeArguments({ path: "a.ts", oldText: "a", newText: "b", extra: 1 }),
    ).toThrow();
    expect(edit!.decodeArguments({ path: "a.ts", oldText: "a", newText: "b" })).toEqual({
      path: "a.ts",
      oldText: "a",
      newText: "b",
    });
  });
});
