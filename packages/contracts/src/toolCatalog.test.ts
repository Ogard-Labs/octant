import { describe, expect, it } from "vitest";
import {
  decodeToolActionCapability,
  listClosedToolCatalog,
  lookupClosedToolCatalogEntry,
} from "./index";

describe("closed tool catalog", () => {
  it("indexes existing contract capability ids as a closed Octant-owned set", () => {
    const ids = listClosedToolCatalog()
      .map((entry) => entry.name)
      .sort();
    expect(ids).toEqual([
      "browser-automation",
      "computer-use",
      "harness-bash",
      "harness-context-remaining",
      "harness-delegate",
      "harness-edit",
      "harness-glob",
      "harness-grep",
      "harness-journal-lookup",
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
